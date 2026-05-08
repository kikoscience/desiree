require('dotenv').config();
const express = require('express');
const sql = require('mssql');
const path = require('path');
const session = require('express-session');

const app = express();
const port = process.env.PORT || 3000;

// Body parser
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Trust reverse proxy if running behind one (like Nginx)
app.set('trust proxy', 1);

// Session Configuration
app.use(session({
    secret: process.env.SESSION_SECRET || 'talent-nexus-secret-key-2024',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.SESSION_SECURE === 'true', // Set to true if using HTTPS via reverse proxy
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
}));

const dbConfig = {
    user: process.env.DB_USER || 'sa',
    password: process.env.DB_PASSWORD || 'Rfx14w.14w.',
    server: process.env.DB_SERVER || 'host.docker.internal',
    database: process.env.DB_DATABASE || 'EmployeeManagement',
    options: {
        encrypt: false,
        trustServerCertificate: true
    }
};

// --- DATABASE INITIALIZATION ---
async function initDb(retries = 5) {
    while (retries > 0) {
        try {
            // First, connect to master to ensure the database exists
            const masterConfig = { ...dbConfig, database: 'master' };
            const masterPool = new sql.ConnectionPool(masterConfig);
            await masterPool.connect();
            await masterPool.request().query(`
                IF NOT EXISTS (SELECT * FROM sys.databases WHERE name = '${dbConfig.database}')
                BEGIN
                    CREATE DATABASE [${dbConfig.database}];
                END
            `);
            await masterPool.close();

            // Connect to our actual database
            const pool = await sql.connect(dbConfig);
            console.log('Initializing Database Components...');

            // 1. Employees Table
            await pool.request().query(`
                IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[Employees]') AND type in (N'U'))
                BEGIN
                    CREATE TABLE [dbo].[Employees] (
                        IdNumber VARCHAR(50) PRIMARY KEY,
                        FullName VARCHAR(255) NOT NULL,
                        Position VARCHAR(255),
                        Department VARCHAR(255),
                        Unit VARCHAR(255),
                        DateOfBirth DATE,
                        GsisBpNo VARCHAR(50),
                        PagIbigMidNo VARCHAR(50),
                        PhicNo VARCHAR(50),
                        TinNo VARCHAR(50),
                        BloodType VARCHAR(10),
                        MedicalConditions NVARCHAR(MAX),
                        EmergencyContactPerson VARCHAR(255),
                        EmergencyContactNumber VARCHAR(50),
                        EmergencyContactAddress NVARCHAR(MAX)
                    );
                END
            `);

            // 2. Users Table
            await pool.request().query(`
                IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[Users]') AND type in (N'U'))
                BEGIN
                    CREATE TABLE [dbo].[Users] (
                        Username VARCHAR(50) PRIMARY KEY,
                        Password VARCHAR(255) NOT NULL,
                        FullName VARCHAR(255),
                        Role VARCHAR(20) NOT NULL -- 'admin' or 'encoder'
                    );
                    
                    -- Seed Sample Accounts
                    INSERT INTO [dbo].[Users] (Username, Password, FullName, Role)
                    VALUES 
                    ('admin', 'admin123', 'System Administrator', 'admin'),
                    ('encoder', 'encoder123', 'Data Encoder', 'encoder');
                END
            `);

            console.log('Database initialization check complete.');
            break; // Exit loop on success
        } catch (err) {
            console.error(`Database Initialization Error. Retries left: ${retries - 1}`, err.message);
            retries -= 1;
            if (retries === 0) {
                console.error('Failed to connect to database after multiple attempts.');
            } else {
                await new Promise(res => setTimeout(res, 5000)); // Wait 5 seconds before retrying
            }
        }
    }
}

initDb();

// --- AUTHENTICATION MIDDLEWARE ---
const requireAuth = (req, res, next) => {
    if (!req.session.user) {
        return res.status(401).json({ message: 'Authentication required' });
    }
    next();
};

const requireAdmin = (req, res, next) => {
    if (!req.session.user || req.session.user.role !== 'admin') {
        return res.status(403).json({ message: 'Administrator authority required' });
    }
    next();
};

// --- AUTH ENDPOINTS ---

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const pool = await sql.connect(dbConfig);
        const result = await pool.request()
            .input('username', sql.VarChar, username)
            .input('password', sql.VarChar, password)
            .query('SELECT * FROM [dbo].[Users] WHERE Username = @username AND Password = @password');

        if (result.recordset.length > 0) {
            const user = result.recordset[0];
            req.session.user = {
                username: user.Username,
                fullName: user.FullName,
                role: user.Role
            };
            res.json({ message: 'Login successful', user: req.session.user });
        } else {
            res.status(401).json({ message: 'Invalid credentials' });
        }
    } catch (err) {
        res.status(500).json({ message: 'Login Error', error: err.message });
    }
});

app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ message: 'Logged out successfully' });
});

app.get('/api/me', (req, res) => {
    if (req.session.user) {
        res.json(req.session.user);
    } else {
        res.status(401).json({ message: 'Not logged in' });
    }
});

app.post('/api/change-password', requireAuth, async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    const username = req.session.user.username;

    try {
        const pool = await sql.connect(dbConfig);
        
        // Verify current password
        const verify = await pool.request()
            .input('username', sql.VarChar, username)
            .input('password', sql.VarChar, currentPassword)
            .query('SELECT * FROM [dbo].[Users] WHERE Username = @username AND Password = @password');

        if (verify.recordset.length === 0) {
            return res.status(400).json({ message: 'Incorrect current password' });
        }

        // Update password
        await pool.request()
            .input('username', sql.VarChar, username)
            .input('password', sql.VarChar, newPassword)
            .query('UPDATE [dbo].[Users] SET Password = @password WHERE Username = @username');

        res.json({ message: 'Password updated successfully' });
    } catch (err) {
        res.status(500).json({ message: 'Error updating password', error: err.message });
    }
});

// --- API ENDPOINTS ---

app.get('/api/employees', requireAuth, async (req, res) => {
    try {
        const pool = await sql.connect(dbConfig);
        const { search = '', page = 1, limit = 10 } = req.query;
        const offset = (page - 1) * limit;
        const searchPattern = `%${search}%`;
        
        const countResult = await pool.request()
            .input('search', sql.VarChar, searchPattern)
            .query(`
                SELECT COUNT(*) as total 
                FROM [dbo].[Employees] 
                WHERE FullName LIKE @search 
                   OR IdNumber LIKE @search 
                   OR Position LIKE @search 
                   OR Department LIKE @search
            `);
        const total = countResult.recordset[0].total;

        const dataResult = await pool.request()
            .input('search', sql.VarChar, searchPattern)
            .input('offset', sql.Int, offset)
            .input('limit', sql.Int, parseInt(limit))
            .query(`
                SELECT * FROM [dbo].[Employees] 
                WHERE FullName LIKE @search 
                   OR IdNumber LIKE @search 
                   OR Position LIKE @search 
                   OR Department LIKE @search
                ORDER BY FullName
                OFFSET @offset ROWS
                FETCH NEXT @limit ROWS ONLY
            `);

        res.json({
            data: dataResult.recordset,
            total,
            page: parseInt(page),
            totalPages: Math.ceil(total / limit)
        });
    } catch (err) {
        res.status(500).json({ message: 'Database Error', error: err.message });
    }
});

app.get('/api/employees/:id', requireAuth, async (req, res) => {
    try {
        const pool = await sql.connect(dbConfig);
        const result = await pool.request()
            .input('IdNumber', sql.VarChar, req.params.id)
            .query('SELECT * FROM [dbo].[Employees] WHERE IdNumber = @IdNumber');
        
        if (result.recordset.length === 0) {
            return res.status(404).json({ message: 'Employee not found' });
        }
        res.json(result.recordset[0]);
    } catch (err) {
        res.status(500).json({ message: 'Database Error', error: err.message });
    }
});

app.post('/api/employees', requireAuth, async (req, res) => {
    try {
        const pool = await sql.connect(dbConfig);
        const data = req.body;
        await pool.request()
            .input('IdNumber', sql.VarChar, data.IdNumber)
            .input('FullName', sql.VarChar, data.FullName)
            .input('Position', sql.VarChar, data.Position)
            .input('Department', sql.VarChar, data.Department)
            .input('Unit', sql.VarChar, data.Unit)
            .input('DateOfBirth', sql.Date, data.DateOfBirth || null)
            .input('GsisBpNo', sql.VarChar, data.GsisBpNo)
            .input('PagIbigMidNo', sql.VarChar, data.PagIbigMidNo)
            .input('PhicNo', sql.VarChar, data.PhicNo)
            .input('TinNo', sql.VarChar, data.TinNo)
            .input('BloodType', sql.VarChar, data.BloodType)
            .input('MedicalConditions', sql.NVarChar, data.MedicalConditions)
            .input('EmergencyContactPerson', sql.VarChar, data.EmergencyContactPerson)
            .input('EmergencyContactNumber', sql.VarChar, data.EmergencyContactNumber)
            .input('EmergencyContactAddress', sql.NVarChar, data.EmergencyContactAddress)
            .query(`
                INSERT INTO [dbo].[Employees] (
                    IdNumber, FullName, Position, Department, Unit, DateOfBirth, 
                    GsisBpNo, PagIbigMidNo, PhicNo, TinNo, BloodType, MedicalConditions, 
                    EmergencyContactPerson, EmergencyContactNumber, EmergencyContactAddress
                )
                VALUES (
                    @IdNumber, @FullName, @Position, @Department, @Unit, @DateOfBirth,
                    @GsisBpNo, @PagIbigMidNo, @PhicNo, @TinNo, @BloodType, @MedicalConditions,
                    @EmergencyContactPerson, @EmergencyContactNumber, @EmergencyContactAddress
                )
            `);
        res.status(201).json({ message: 'Employee added successfully!' });
    } catch (err) {
        res.status(500).json({ message: 'Database Error', error: err.message });
    }
});

app.put('/api/employees/:id', requireAuth, async (req, res) => {
    try {
        const pool = await sql.connect(dbConfig);
        const data = req.body;
        await pool.request()
            .input('OriginalId', sql.VarChar, req.params.id)
            .input('IdNumber', sql.VarChar, data.IdNumber)
            .input('FullName', sql.VarChar, data.FullName)
            .input('Position', sql.VarChar, data.Position)
            .input('Department', sql.VarChar, data.Department)
            .input('Unit', sql.VarChar, data.Unit)
            .input('DateOfBirth', sql.Date, data.DateOfBirth || null)
            .input('GsisBpNo', sql.VarChar, data.GsisBpNo)
            .input('PagIbigMidNo', sql.VarChar, data.PagIbigMidNo)
            .input('PhicNo', sql.VarChar, data.PhicNo)
            .input('TinNo', sql.VarChar, data.TinNo)
            .input('BloodType', sql.VarChar, data.BloodType)
            .input('MedicalConditions', sql.NVarChar, data.MedicalConditions)
            .input('EmergencyContactPerson', sql.VarChar, data.EmergencyContactPerson)
            .input('EmergencyContactNumber', sql.VarChar, data.EmergencyContactNumber)
            .input('EmergencyContactAddress', sql.NVarChar, data.EmergencyContactAddress)
            .query(`
                UPDATE [dbo].[Employees] SET 
                    IdNumber = @IdNumber,
                    FullName = @FullName,
                    Position = @Position,
                    Department = @Department,
                    Unit = @Unit,
                    DateOfBirth = @DateOfBirth,
                    GsisBpNo = @GsisBpNo,
                    PagIbigMidNo = @PagIbigMidNo,
                    PhicNo = @PhicNo,
                    TinNo = @TinNo,
                    BloodType = @BloodType,
                    MedicalConditions = @MedicalConditions,
                    EmergencyContactPerson = @EmergencyContactPerson,
                    EmergencyContactNumber = @EmergencyContactNumber,
                    EmergencyContactAddress = @EmergencyContactAddress
                WHERE IdNumber = @OriginalId
            `);
        res.json({ message: 'Employee updated successfully!' });
    } catch (err) {
        res.status(500).json({ message: 'Database Error', error: err.message });
    }
});

app.delete('/api/employees/:id', requireAdmin, async (req, res) => {
    try {
        const pool = await sql.connect(dbConfig);
        await pool.request()
            .input('IdNumber', sql.VarChar, req.params.id)
            .query('DELETE FROM [dbo].[Employees] WHERE IdNumber = @IdNumber');
        res.json({ message: 'Employee deleted successfully!' });
    } catch (err) {
        res.status(500).json({ message: 'Database Error', error: err.message });
    }
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

app.listen(port, '0.0.0.0', () => {
    console.log(`Server is listening on http://0.0.0.0:${port}`);
});
