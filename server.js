require('dotenv').config();
const express = require('express');
const sql = require('mssql');
const mysql = require('mysql2/promise');
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

// HRIS master employee data source (MySQL) — READ-ONLY. No INSERT/UPDATE/DELETE
// is ever issued against this pool; tblemp/tblpi belong to the hris database
// and must not be modified from this app.
const hrisPool = mysql.createPool({
    host: process.env.HRIS_DB_HOST,
    port: parseInt(process.env.HRIS_DB_PORT || '3306', 10),
    user: process.env.HRIS_DB_USER,
    password: process.env.HRIS_DB_PASSWORD,
    database: process.env.HRIS_DB_DATABASE || 'hris',
    waitForConnections: true,
    connectionLimit: 5
});

const HRIS_EMPLOYEE_SELECT = `
    SELECT
        e.Employee_No, e.Full_Name, e.First_Name, e.Middle_Name, e.Last_Name, e.Ext_Name,
        e.Birthday, e.Office, e.Position, e.Employment_Status, e.Status, e.CP_Emergency,
        e.PRC_No, e.PRC_ExpDate, e.PH_Accred, e.PhAccred_ExpDate,
        p.Sex, p.Civil_Status, p.Blood_Type, p.GSIS_No, p.Pagibig_No, p.Philhealth_No,
        p.SSS_No, p.TIN_No
    FROM tblemp e
    LEFT JOIN tblpi p ON p.emp_ID = e.emp_ID
`;

// --- DATABASE INITIALIZATION (local app database only — hris is untouched) ---
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

            // 1. EmployeeSupplement Table — holds only the fields hris.tblemp/tblpi
            // don't already have, keyed by the hris Employee_No. Master employee
            // data (name, position, office, statutory numbers) always comes live
            // from hris and is never duplicated or written back here.
            await pool.request().query(`
                IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[EmployeeSupplement]') AND type in (N'U'))
                BEGIN
                    CREATE TABLE [dbo].[EmployeeSupplement] (
                        EmployeeNo VARCHAR(20) PRIMARY KEY,
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

// --- HELPERS ---

// Merge live hris master data with the local supplement row for one employee.
function mergeEmployee(hrisRow, supplementRow) {
    return {
        IdNumber: hrisRow.Employee_No,
        FullName: hrisRow.Full_Name,
        FirstName: hrisRow.First_Name,
        MiddleName: hrisRow.Middle_Name,
        LastName: hrisRow.Last_Name,
        ExtName: hrisRow.Ext_Name,
        Position: hrisRow.Position,
        Department: hrisRow.Office,
        EmploymentStatus: hrisRow.Employment_Status,
        Status: hrisRow.Status,
        DateOfBirth: hrisRow.Birthday,
        Sex: hrisRow.Sex,
        CivilStatus: hrisRow.Civil_Status,
        BloodType: hrisRow.Blood_Type,
        GsisBpNo: hrisRow.GSIS_No,
        PagIbigMidNo: hrisRow.Pagibig_No,
        PhicNo: hrisRow.Philhealth_No,
        SssNo: hrisRow.SSS_No,
        TinNo: hrisRow.TIN_No,
        PrcNo: hrisRow.PRC_No,
        PrcExpDate: hrisRow.PRC_ExpDate,
        PhAccredNo: hrisRow.PH_Accred,
        PhAccredExpDate: hrisRow.PhAccred_ExpDate,
        HrisEmergencyContact: hrisRow.CP_Emergency,
        MedicalConditions: supplementRow ? supplementRow.MedicalConditions : null,
        EmergencyContactPerson: supplementRow ? supplementRow.EmergencyContactPerson : null,
        EmergencyContactNumber: supplementRow ? supplementRow.EmergencyContactNumber : null,
        EmergencyContactAddress: supplementRow ? supplementRow.EmergencyContactAddress : null
    };
}

// --- API ENDPOINTS ---

// Read-only lookup against hris, used to confirm an Employee_No exists before
// attaching supplemental data to it.
app.get('/api/hris-employee/:employeeNo', requireAuth, async (req, res) => {
    try {
        const [rows] = await hrisPool.query(
            `${HRIS_EMPLOYEE_SELECT} WHERE e.Employee_No = ? LIMIT 1`,
            [req.params.employeeNo]
        );
        if (rows.length === 0) {
            return res.status(404).json({ message: 'Employee not found in HRIS' });
        }
        res.json(mergeEmployee(rows[0], null));
    } catch (err) {
        res.status(500).json({ message: 'HRIS Lookup Error', error: err.message });
    }
});

app.get('/api/employees', requireAuth, async (req, res) => {
    try {
        const { search = '', page = 1, limit = 10 } = req.query;
        const offset = (page - 1) * limit;
        const searchPattern = `%${search}%`;

        const [countRows] = await hrisPool.query(
            `SELECT COUNT(*) as total FROM tblemp e
             WHERE e.Full_Name LIKE ? OR e.Employee_No LIKE ? OR e.Position LIKE ? OR e.Office LIKE ?`,
            [searchPattern, searchPattern, searchPattern, searchPattern]
        );
        const total = countRows[0].total;

        const [hrisRows] = await hrisPool.query(
            `${HRIS_EMPLOYEE_SELECT}
             WHERE e.Full_Name LIKE ? OR e.Employee_No LIKE ? OR e.Position LIKE ? OR e.Office LIKE ?
             ORDER BY e.Full_Name
             LIMIT ? OFFSET ?`,
            [searchPattern, searchPattern, searchPattern, searchPattern, parseInt(limit), offset]
        );

        const employeeNos = hrisRows.map(r => r.Employee_No);
        const pool = await sql.connect(dbConfig);
        const supplementByNo = {};
        if (employeeNos.length > 0) {
            const request = pool.request();
            const placeholders = employeeNos.map((no, i) => {
                request.input(`no${i}`, sql.VarChar, no);
                return `@no${i}`;
            }).join(', ');
            const supplementResult = await request.query(
                `SELECT * FROM [dbo].[EmployeeSupplement] WHERE EmployeeNo IN (${placeholders})`
            );
            supplementResult.recordset.forEach(row => {
                supplementByNo[row.EmployeeNo] = row;
            });
        }

        const data = hrisRows.map(row => mergeEmployee(row, supplementByNo[row.Employee_No]));

        res.json({
            data,
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
        const [hrisRows] = await hrisPool.query(
            `${HRIS_EMPLOYEE_SELECT} WHERE e.Employee_No = ? LIMIT 1`,
            [req.params.id]
        );
        if (hrisRows.length === 0) {
            return res.status(404).json({ message: 'Employee not found' });
        }

        const pool = await sql.connect(dbConfig);
        const supplementResult = await pool.request()
            .input('EmployeeNo', sql.VarChar, req.params.id)
            .query('SELECT * FROM [dbo].[EmployeeSupplement] WHERE EmployeeNo = @EmployeeNo');

        res.json(mergeEmployee(hrisRows[0], supplementResult.recordset[0]));
    } catch (err) {
        res.status(500).json({ message: 'Database Error', error: err.message });
    }
});

// Creates the local supplemental record for an employee that must already
// exist in hris. Never writes to the hris database itself.
app.post('/api/employees', requireAuth, async (req, res) => {
    try {
        const data = req.body;
        const [hrisRows] = await hrisPool.query(
            'SELECT Employee_No FROM tblemp WHERE Employee_No = ? LIMIT 1',
            [data.IdNumber]
        );
        if (hrisRows.length === 0) {
            return res.status(404).json({ message: 'That Employee No. was not found in HRIS. It must exist in HRIS before supplemental info can be added.' });
        }

        const pool = await sql.connect(dbConfig);
        const existing = await pool.request()
            .input('EmployeeNo', sql.VarChar, data.IdNumber)
            .query('SELECT EmployeeNo FROM [dbo].[EmployeeSupplement] WHERE EmployeeNo = @EmployeeNo');
        if (existing.recordset.length > 0) {
            return res.status(409).json({ message: 'Supplemental info already exists for this employee. Use edit instead.' });
        }

        await pool.request()
            .input('EmployeeNo', sql.VarChar, data.IdNumber)
            .input('MedicalConditions', sql.NVarChar, data.MedicalConditions)
            .input('EmergencyContactPerson', sql.VarChar, data.EmergencyContactPerson)
            .input('EmergencyContactNumber', sql.VarChar, data.EmergencyContactNumber)
            .input('EmergencyContactAddress', sql.NVarChar, data.EmergencyContactAddress)
            .query(`
                INSERT INTO [dbo].[EmployeeSupplement] (
                    EmployeeNo, MedicalConditions, EmergencyContactPerson, EmergencyContactNumber, EmergencyContactAddress
                )
                VALUES (
                    @EmployeeNo, @MedicalConditions, @EmergencyContactPerson, @EmergencyContactNumber, @EmergencyContactAddress
                )
            `);
        res.status(201).json({ message: 'Supplemental info added successfully!' });
    } catch (err) {
        res.status(500).json({ message: 'Database Error', error: err.message });
    }
});

// Updates the local supplemental record only. The Employee_No / master hris
// fields cannot be changed from here.
app.put('/api/employees/:id', requireAuth, async (req, res) => {
    try {
        const data = req.body;
        const pool = await sql.connect(dbConfig);
        await pool.request()
            .input('EmployeeNo', sql.VarChar, req.params.id)
            .input('MedicalConditions', sql.NVarChar, data.MedicalConditions)
            .input('EmergencyContactPerson', sql.VarChar, data.EmergencyContactPerson)
            .input('EmergencyContactNumber', sql.VarChar, data.EmergencyContactNumber)
            .input('EmergencyContactAddress', sql.NVarChar, data.EmergencyContactAddress)
            .query(`
                IF EXISTS (SELECT 1 FROM [dbo].[EmployeeSupplement] WHERE EmployeeNo = @EmployeeNo)
                BEGIN
                    UPDATE [dbo].[EmployeeSupplement] SET
                        MedicalConditions = @MedicalConditions,
                        EmergencyContactPerson = @EmergencyContactPerson,
                        EmergencyContactNumber = @EmergencyContactNumber,
                        EmergencyContactAddress = @EmergencyContactAddress
                    WHERE EmployeeNo = @EmployeeNo
                END
                ELSE
                BEGIN
                    INSERT INTO [dbo].[EmployeeSupplement] (
                        EmployeeNo, MedicalConditions, EmergencyContactPerson, EmergencyContactNumber, EmergencyContactAddress
                    )
                    VALUES (
                        @EmployeeNo, @MedicalConditions, @EmergencyContactPerson, @EmergencyContactNumber, @EmergencyContactAddress
                    )
                END
            `);
        res.json({ message: 'Employee updated successfully!' });
    } catch (err) {
        res.status(500).json({ message: 'Database Error', error: err.message });
    }
});

// Deletes only the local supplemental record. hris master data is untouched.
app.delete('/api/employees/:id', requireAdmin, async (req, res) => {
    try {
        const pool = await sql.connect(dbConfig);
        await pool.request()
            .input('EmployeeNo', sql.VarChar, req.params.id)
            .query('DELETE FROM [dbo].[EmployeeSupplement] WHERE EmployeeNo = @EmployeeNo');
        res.json({ message: 'Supplemental record deleted successfully!' });
    } catch (err) {
        res.status(500).json({ message: 'Database Error', error: err.message });
    }
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

app.listen(port, '0.0.0.0', () => {
    console.log(`Server is listening on http://0.0.0.0:${port}`);
});
