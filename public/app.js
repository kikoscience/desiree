document.addEventListener('DOMContentLoaded', () => {
    // State management
    let currentUser = null;
    let currentPage = 1;
    let totalPages = 1;
    let currentSearch = '';
    const itemsPerPage = 10;
    let employeeToDelete = null;

    // DOM Elements
    const listView = document.getElementById('listView');
    const formView = document.getElementById('formView');
    const employeeTableBody = document.getElementById('employeeTableBody');
    const employeeForm = document.getElementById('employeeForm');
    const searchInput = document.getElementById('searchInput');
    const addNewBtn = document.getElementById('addNewBtn');
    const cancelBtn = document.getElementById('cancelBtn');
    const formTitle = document.getElementById('formTitle');
    const toastContainer = document.getElementById('toastContainer');
    
    // Auth Elements
    const userMenuBtn = document.getElementById('userMenuBtn');
    const userDropdown = document.getElementById('userDropdown');
    const userFullName = document.getElementById('userFullName');
    const userRoleBadge = document.getElementById('userRoleBadge');
    const userAvatar = document.getElementById('userAvatar');
    const logoutBtn = document.getElementById('logoutBtn');
    const changePassBtn = document.getElementById('changePassBtn');
    
    const changePassModal = document.getElementById('changePassModal');
    const changePassForm = document.getElementById('changePassForm');
    const cancelChangePass = document.getElementById('cancelChangePass');

    // --- INITIALIZATION ---
    checkAuth();

    // --- EVENT LISTENERS ---

    // User Menu Toggle
    userMenuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        userDropdown.classList.toggle('hidden');
    });

    document.addEventListener('click', () => {
        userDropdown.classList.add('hidden');
    });

    logoutBtn.addEventListener('click', async () => {
        await fetch('/api/logout', { method: 'POST' });
        window.location.href = '/login.html';
    });

    changePassBtn.addEventListener('click', () => {
        changePassModal.classList.remove('hidden');
    });

    cancelChangePass.addEventListener('click', () => {
        changePassModal.classList.add('hidden');
        changePassForm.reset();
    });

    changePassForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const currentPassword = document.getElementById('currentPassword').value;
        const newPassword = document.getElementById('newPassword').value;

        try {
            const response = await fetch('/api/change-password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ currentPassword, newPassword })
            });

            if (response.ok) {
                showToast('Protocol updated successfully.', 'success');
                changePassModal.classList.add('hidden');
                changePassForm.reset();
            } else {
                const data = await response.json();
                throw new Error(data.message);
            }
        } catch (err) {
            showToast(err.message, 'error');
        }
    });

    addNewBtn.addEventListener('click', () => showForm());
    cancelBtn.addEventListener('click', () => showList());

    // Search logic with debounce
    let debounceTimer;
    searchInput.addEventListener('input', (e) => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            currentSearch = e.target.value;
            currentPage = 1;
            fetchEmployees();
        }, 300);
    });

    // Pagination Elements
    const prevPageBtn = document.getElementById('prevPage');
    const nextPageBtn = document.getElementById('nextPage');
    const currentPageSpan = document.getElementById('currentPage');
    const pageRangeSpan = document.getElementById('pageRange');
    const totalRecordsSpan = document.getElementById('totalRecords');

    prevPageBtn.addEventListener('click', () => {
        if (currentPage > 1) {
            currentPage--;
            fetchEmployees();
        }
    });

    nextPageBtn.addEventListener('click', () => {
        if (currentPage < totalPages) {
            currentPage++;
            fetchEmployees();
        }
    });

    // Form Submission (Create/Update)
    employeeForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const formData = new FormData(employeeForm);
        const data = Object.fromEntries(formData.entries());
        const isUpdate = !!data.originalId;
        
        const url = isUpdate ? `/api/employees/${data.originalId}` : '/api/employees';
        const method = isUpdate ? 'PUT' : 'POST';

        const submitBtn = document.getElementById('submitBtn');
        const loader = submitBtn.querySelector('.loader');
        const btnText = submitBtn.querySelector('.btn-text');
        
        if (submitBtn) submitBtn.disabled = true;
        if (loader) loader.classList.remove('hidden');
        if (btnText) btnText.style.opacity = '0.5';

        try {
            const response = await fetch(url, {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || 'Failed to save record');
            }

            showToast(isUpdate ? 'Profile synchronized successfully.' : 'New talent onboarded.', 'success');
            showList();
            fetchEmployees();
        } catch (err) {
            showToast(`Error: ${err.message}`, 'error');
        } finally {
            if (submitBtn) submitBtn.disabled = false;
            if (loader) loader.classList.add('hidden');
            if (btnText) btnText.style.opacity = '1';
        }
    });

    // Delete Modal Elements
    const deleteModal = document.getElementById('deleteModal');
    const confirmDeleteBtn = document.getElementById('confirmDelete');
    const cancelDeleteBtn = document.getElementById('cancelDelete');
    const deleteEmployeeName = document.getElementById('deleteEmployeeName');

    // --- FUNCTIONS ---

    async function checkAuth() {
        try {
            const response = await fetch('/api/me');
            if (response.ok) {
                currentUser = await response.json();
                updateUserUI();
                fetchEmployees();
            } else {
                window.location.href = '/login.html';
            }
        } catch (err) {
            window.location.href = '/login.html';
        }
    }

    function updateUserUI() {
        userFullName.textContent = currentUser.fullName;
        userRoleBadge.textContent = currentUser.role;
        userAvatar.textContent = currentUser.fullName.charAt(0);
        
        // Custom color for roles
        if (currentUser.role === 'admin') {
            userRoleBadge.style.color = '#a855f7'; // Accent purple
            userRoleBadge.style.borderColor = 'rgba(168, 85, 247, 0.3)';
        } else {
            userRoleBadge.style.color = '#6366f1'; // Primary indigo
            userRoleBadge.style.borderColor = 'rgba(99, 102, 241, 0.3)';
        }
    }

    async function fetchEmployees() {
        try {
            const response = await fetch(`/api/employees?search=${encodeURIComponent(currentSearch)}&page=${currentPage}&limit=${itemsPerPage}`);
            const result = await response.json();

            renderTable(result.data);
            updatePaginationUI(result);
        } catch (err) {
            showToast('Failed to load the talent nexus.', 'error');
        }
    }

    function renderTable(data) {
        employeeTableBody.innerHTML = '';
        
        if (data.length === 0) {
            employeeTableBody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding: 6rem; color: var(--text-low);">No profiles detected.</td></tr>`;
            return;
        }

        data.forEach(emp => {
            const initial = emp.FullName ? emp.FullName.charAt(0).toUpperCase() : '?';
            const isAdmin = currentUser && currentUser.role === 'admin';
            
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><span class="identity-badge">${emp.IdNumber}</span></td>
                <td>
                    <div style="display:flex; align-items:center; gap:12px;">
                        <div class="avatar">${initial}</div>
                        <strong>${emp.FullName || 'Unnamed'}</strong>
                    </div>
                </td>
                <td><span style="color: var(--text-high); font-weight: 500;">${emp.Position}</span></td>
                <td><span class="tag">${emp.Department}</span></td>
                <td>${emp.Unit || '<span style="color:var(--text-low)">-</span>'}</td>
                <td>
                    <div class="action-cell">
                        <button class="btn-edit" data-id="${emp.IdNumber}">Edit</button>
                        ${isAdmin ? `<button class="btn-danger" data-id="${emp.IdNumber}" data-name="${emp.FullName}">Delete</button>` : ''}
                    </div>
                </td>
            `;
            
            tr.querySelector('.btn-edit').addEventListener('click', () => loadEmployeeForEdit(emp.IdNumber));
            if (isAdmin) {
                tr.querySelector('.btn-danger').addEventListener('click', () => {
                    employeeToDelete = emp.IdNumber;
                    deleteEmployeeName.textContent = emp.FullName;
                    deleteModal.classList.remove('hidden');
                });
            }

            employeeTableBody.appendChild(tr);
        });
    }

    async function loadEmployeeForEdit(id) {
        try {
            const response = await fetch(`/api/employees/${id}`);
            const emp = await response.json();
            showForm(true);
            
            // Fill form
            document.getElementById('originalId').value = emp.IdNumber;
            document.getElementById('IdNumber').value = emp.IdNumber;
            document.getElementById('FullName').value = emp.FullName;
            document.getElementById('Department').value = emp.Department;
            document.getElementById('Position').value = emp.Position;
            document.getElementById('Unit').value = emp.Unit || '';
            if (emp.DateOfBirth) document.getElementById('DateOfBirth').value = emp.DateOfBirth.split('T')[0];
            document.getElementById('BloodType').value = emp.BloodType || '';
            document.getElementById('TinNo').value = emp.TinNo || '';
            document.getElementById('PhicNo').value = emp.PhicNo || '';
            document.getElementById('PagIbigMidNo').value = emp.PagIbigMidNo || '';
            document.getElementById('GsisBpNo').value = emp.GsisBpNo || '';
            document.getElementById('MedicalConditions').value = emp.MedicalConditions || '';
            document.getElementById('EmergencyContactPerson').value = emp.EmergencyContactPerson || '';
            document.getElementById('EmergencyContactNumber').value = emp.EmergencyContactNumber || '';
            document.getElementById('EmergencyContactAddress').value = emp.EmergencyContactAddress || '';
        } catch (err) {
            showToast('Error loading profile.', 'error');
        }
    }

    function updatePaginationUI(result) {
        totalPages = result.totalPages;
        currentPageSpan.textContent = result.page;
        totalRecordsSpan.textContent = result.total;
        const start = (result.page - 1) * itemsPerPage + 1;
        const end = Math.min(result.page * itemsPerPage, result.total);
        pageRangeSpan.textContent = result.total > 0 ? `${start}-${end}` : '0-0';
        prevPageBtn.disabled = result.page <= 1;
        nextPageBtn.disabled = result.page >= result.totalPages;
    }

    function showForm(isEdit = false) {
        listView.classList.add('hidden');
        formView.classList.remove('hidden');
        formTitle.textContent = isEdit ? 'Modify Talent Profile' : 'Initialize Talent Profile';
        if (!isEdit) {
            employeeForm.reset();
            document.getElementById('originalId').value = '';
        }
    }

    function showList() {
        formView.classList.add('hidden');
        listView.classList.remove('hidden');
        employeeForm.reset();
    }

    function showToast(msg, type = 'info') {
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.innerHTML = `
            <div class="toast-icon">${type === 'success' ? '✓' : type === 'error' ? '⚠' : 'ℹ'}</div>
            <div class="toast-message">${msg}</div>
        `;
        toastContainer.appendChild(toast);
        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transform = 'translateX(20px)';
            setTimeout(() => toast.remove(), 300);
        }, 4000);
    }

    // Delete Modal Actions
    cancelDeleteBtn.addEventListener('click', () => {
        deleteModal.classList.add('hidden');
        employeeToDelete = null;
    });

    confirmDeleteBtn.addEventListener('click', async () => {
        if (!employeeToDelete) return;
        try {
            const response = await fetch(`/api/employees/${employeeToDelete}`, { method: 'DELETE' });
            if (response.ok) {
                showToast('Record purged from nexus.', 'success');
                fetchEmployees();
            } else {
                const data = await response.json();
                throw new Error(data.message || 'Purge authority denied.');
            }
        } catch (err) {
            showToast(err.message, 'error');
        } finally {
            deleteModal.classList.add('hidden');
            employeeToDelete = null;
        }
    });
});
