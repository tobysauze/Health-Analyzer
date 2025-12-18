// Global variables
let charts = {};
let currentData = {
    sleep: [],
    activity: [],
    nutrition: [],
    mood: [],
    foodLog: [],
    supplements: [],
    medications: []
};
let socket = null;

// Food packaging analysis: allow file upload + paste/drag images
let foodPackagingExtraFiles = [];
let foodPackagingPreviewUrls = [];

// Shared exercise library (Fitness page)
let exerciseLibrary = [];

// Initialize the application
document.addEventListener('DOMContentLoaded', function () {
    initializeApp();
});

let appBootstrapped = false;

function startApp() {
    if (appBootstrapped) return;
    appBootstrapped = true;
    // Safe to load app data now
    loadDashboardData();
    // Preload journal list (safe even if tab not open yet)
    loadJournalList().catch(() => { });
    loadFoodPhotos().catch(() => { });
    // Default strength sets table
    initStrengthSetsTable();
    // Preload exercise library for Fitness autocomplete
    refreshExerciseLibrary().catch(() => { });
}

async function initializeApp() {
    setupEventListeners();
    setupRangeSliders();
    setDefaultDates();

    if (window.AuthClient && typeof window.AuthClient.init === 'function') {
        await window.AuthClient.init({
            onAuthenticated: () => startApp(),
            onLogout: () => { appBootstrapped = false; }
        });
    } else {
        // Fallback: if auth client missing, attempt to start app anyway
        startApp();
    }
}

// Event Listeners Setup
function setupEventListeners() {
    // Tab navigation
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', function () {
            switchTab(this.dataset.tab);
        });
    });

    // Expand/Collapse all buttons (optional - may have been removed)
    const expandAllBtn = document.getElementById('expandAllBtn');
    const collapseAllBtn = document.getElementById('collapseAllBtn');
    if (expandAllBtn) expandAllBtn.addEventListener('click', expandAllCards);
    if (collapseAllBtn) collapseAllBtn.addEventListener('click', collapseAllCards);

    // Form submissions
    document.getElementById('sleepForm').addEventListener('submit', handleSleepSubmit);
    document.getElementById('activityForm').addEventListener('submit', handleActivitySubmit);
    document.getElementById('foodLogForm').addEventListener('submit', handleFoodLogSubmit);
    document.getElementById('moodForm').addEventListener('submit', handleMoodSubmit);
    // Supplements (new regimen + day view)
    const supplementsDayRefreshBtn = document.getElementById('supplementsDayRefreshBtn');
    if (supplementsDayRefreshBtn) supplementsDayRefreshBtn.addEventListener('click', () => loadSupplementsDay().catch(() => { }));
    const supplementsDayDate = document.getElementById('supplementsDayDate');
    if (supplementsDayDate) supplementsDayDate.addEventListener('change', () => loadSupplementsDay().catch(() => { }));
    const supplementRegimenForm = document.getElementById('supplementRegimenForm');
    if (supplementRegimenForm) supplementRegimenForm.addEventListener('submit', handleSupplementRegimenSubmit);
    const suppRegimensRefreshBtn = document.getElementById('suppRegimensRefreshBtn');
    if (suppRegimensRefreshBtn) suppRegimensRefreshBtn.addEventListener('click', () => loadSupplementRegimens().catch(() => { }));
    // Medications (new regimen + day view)
    const medicationsDayRefreshBtn = document.getElementById('medicationsDayRefreshBtn');
    if (medicationsDayRefreshBtn) medicationsDayRefreshBtn.addEventListener('click', () => loadMedicationsDay().catch(() => { }));
    const medicationsDayDate = document.getElementById('medicationsDayDate');
    if (medicationsDayDate) medicationsDayDate.addEventListener('change', () => loadMedicationsDay().catch(() => { }));
    const medicationRegimenForm = document.getElementById('medicationRegimenForm');
    if (medicationRegimenForm) medicationRegimenForm.addEventListener('submit', handleMedicationRegimenSubmit);
    const medRegimensRefreshBtn = document.getElementById('medRegimensRefreshBtn');
    if (medRegimensRefreshBtn) medRegimensRefreshBtn.addEventListener('click', () => loadMedicationRegimens().catch(() => { }));
    document.getElementById('geneticUploadForm').addEventListener('submit', handleGeneticUpload);
    document.getElementById('garminUploadForm').addEventListener('submit', handleGarminUpload);
    const appleHealthForm = document.getElementById('appleHealthUploadForm');
    if (appleHealthForm) appleHealthForm.addEventListener('submit', handleAppleHealthUpload);
    const androidHealthForm = document.getElementById('androidHealthUploadForm');
    if (androidHealthForm) androidHealthForm.addEventListener('submit', handleAndroidHealthUpload);
    document.getElementById('journalForm').addEventListener('submit', handleJournalSubmit);
    document.getElementById('journalAnalyzeBtn').addEventListener('click', handleJournalAnalyze);
    document.getElementById('foodPhotoForm').addEventListener('submit', handleFoodPhotoUpload);
    const foodPackagingForm = document.getElementById('foodPackagingForm');
    if (foodPackagingForm) foodPackagingForm.addEventListener('submit', handleFoodPackagingUpload);
    setupFoodPackagingPaste();
    loadFoodPackagingModels().catch(() => { });
    document.getElementById('runForm').addEventListener('submit', handleRunSubmit);

    const setCalorieGoalBtn = document.getElementById('setCalorieGoalBtn');
    if (setCalorieGoalBtn) {
        setCalorieGoalBtn.addEventListener('click', () => openCalorieGoalModal().catch(() => { }));
    }
    const caloriesCard = document.getElementById('caloriesCard');
    if (caloriesCard) {
        caloriesCard.style.cursor = 'pointer';
        caloriesCard.addEventListener('click', (e) => {
            // Don't hijack clicks on the goal button
            if (e.target?.closest?.('#setCalorieGoalBtn')) return;
            switchTab('food');
            document.getElementById('foodLogForm')?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
        });
    }

    const sleepMetricCard = document.getElementById('sleepMetricCard');
    if (sleepMetricCard) {
        sleepMetricCard.style.cursor = 'pointer';
        sleepMetricCard.addEventListener('click', () => openTabAndScroll('sleep', 'sleepCard'));
    }

    const stepsMetricCard = document.getElementById('stepsMetricCard');
    if (stepsMetricCard) {
        stepsMetricCard.style.cursor = 'pointer';
        stepsMetricCard.addEventListener('click', () => openTabAndScroll('activity', 'activityCard'));
    }

    const moodMetricCard = document.getElementById('moodMetricCard');
    if (moodMetricCard) {
        moodMetricCard.style.cursor = 'pointer';
        moodMetricCard.addEventListener('click', () => openTabAndScroll('mood', 'moodCard'));
    }
    // Safety net: if something prevents direct binding, delegate click.
    document.addEventListener('click', (e) => {
        const t = e.target?.closest?.('#setCalorieGoalBtn');
        if (!t) return;
        openCalorieGoalModal().catch(() => { });
    });

    // Sidebar toggle buttons (floating and in-menu)
    const sidebarToggleBtnFloating = document.getElementById('sidebarToggleBtnFloating');
    const sidebarToggleBtnInMenu = document.getElementById('sidebarToggleBtnInMenu');

    const toggleSidebar = () => {
        document.body.classList.toggle('sidebar-collapsed');
    };

    if (sidebarToggleBtnFloating) {
        sidebarToggleBtnFloating.addEventListener('click', toggleSidebar);
    }
    if (sidebarToggleBtnInMenu) {
        sidebarToggleBtnInMenu.addEventListener('click', toggleSidebar);
    }
    document.getElementById('strengthForm').addEventListener('submit', handleStrengthSubmit);
    document.getElementById('addSetBtn').addEventListener('click', () => addSetRow());
    document.getElementById('refreshFitnessBtn').addEventListener('click', refreshFitnessCharts);
    const exerciseAddForm = document.getElementById('exerciseAddForm');
    if (exerciseAddForm) exerciseAddForm.addEventListener('submit', handleExerciseAdd);
    document.getElementById('startBarcodeBtn').addEventListener('click', startBarcodeScanner);
    document.getElementById('lookupBarcodeBtn').addEventListener('click', lookupBarcode);

    // Food log quick actions (jump to Food Scan tools)
    const foodLogGoPhotoBtn = document.getElementById('foodLogGoPhotoBtn');
    if (foodLogGoPhotoBtn) foodLogGoPhotoBtn.addEventListener('click', () => goToFoodScanTool('foodPhotoForm'));
    const foodLogGoBarcodeBtn = document.getElementById('foodLogGoBarcodeBtn');
    if (foodLogGoBarcodeBtn) foodLogGoBarcodeBtn.addEventListener('click', () => goToFoodScanTool('barcodeInput'));
    const foodLogGoPackagingBtn = document.getElementById('foodLogGoPackagingBtn');
    if (foodLogGoPackagingBtn) foodLogGoPackagingBtn.addEventListener('click', () => goToFoodScanTool('packagingScanSection'));
    const foodAiEstimateBtn = document.getElementById('foodAiEstimateBtn');
    if (foodAiEstimateBtn) foodAiEstimateBtn.addEventListener('click', () => estimateFoodFromText().catch(() => { }));
    document.getElementById('bodyCompImportForm').addEventListener('submit', handleBodyCompImport);

    // Analysis buttons
    document.getElementById('runCorrelationBtn').addEventListener('click', runCorrelationAnalysis);
    document.getElementById('checkInteractionsBtn').addEventListener('click', checkDrugInteractions);
    document.getElementById('generateRecommendationsBtn').addEventListener('click', generateRecommendations);

    // Garmin integration
    document.getElementById('exportDataBtn').addEventListener('click', exportData);
    const garminDbSyncBtn = document.getElementById('garminDbSyncBtn');
    if (garminDbSyncBtn) garminDbSyncBtn.addEventListener('click', runGarminDbAutoSync);

    // Insights
    const refreshInsightsBtn = document.getElementById('refreshInsightsBtn');
    if (refreshInsightsBtn) refreshInsightsBtn.addEventListener('click', refreshWeeklyInsights);
    const saveCheckinBtn = document.getElementById('saveCheckinBtn');
    if (saveCheckinBtn) saveCheckinBtn.addEventListener('click', saveManualCheckin);

    // Morning routine
    const routineTodayBtn = document.getElementById('routineTodayBtn');
    if (routineTodayBtn) routineTodayBtn.addEventListener('click', () => {
        const input = document.getElementById('routineDate');
        if (input) input.value = new Date().toISOString().split('T')[0];
        loadMorningRoutine().catch(() => { });
    });
    const routineRefreshBtn = document.getElementById('routineRefreshBtn');
    if (routineRefreshBtn) routineRefreshBtn.addEventListener('click', () => loadMorningRoutine().catch(() => { }));
    const routineDate = document.getElementById('routineDate');
    if (routineDate) routineDate.addEventListener('change', () => loadMorningRoutine().catch(() => { }));
    const routineSeedMetricsBtn = document.getElementById('routineSeedMetricsBtn');
    if (routineSeedMetricsBtn) routineSeedMetricsBtn.addEventListener('click', seedRoutineMetrics);
    const routineAddItemForm = document.getElementById('routineAddItemForm');
    if (routineAddItemForm) routineAddItemForm.addEventListener('submit', handleRoutineAddItem);

    // Evening routine
    const eveningTodayBtn = document.getElementById('eveningRoutineTodayBtn');
    if (eveningTodayBtn) eveningTodayBtn.addEventListener('click', () => {
        const input = document.getElementById('eveningRoutineDate');
        if (input) input.value = new Date().toISOString().split('T')[0];
        loadEveningRoutine().catch(() => { });
    });
    const eveningRefreshBtn = document.getElementById('eveningRoutineRefreshBtn');
    if (eveningRefreshBtn) eveningRefreshBtn.addEventListener('click', () => loadEveningRoutine().catch(() => { }));
    const eveningDate = document.getElementById('eveningRoutineDate');
    if (eveningDate) eveningDate.addEventListener('change', () => loadEveningRoutine().catch(() => { }));
    const eveningSeedBtn = document.getElementById('eveningRoutineSeedBtn');
    if (eveningSeedBtn) eveningSeedBtn.addEventListener('click', seedEveningRoutine);
    const eveningAddForm = document.getElementById('eveningRoutineAddItemForm');
    if (eveningAddForm) eveningAddForm.addEventListener('submit', handleEveningRoutineAddItem);
}

async function estimateFoodFromText() {
    const name = document.getElementById('foodName')?.value || '';
    const qty = document.getElementById('foodQty')?.value || '';
    const unit = document.getElementById('foodQtyUnit')?.value || 'g';
    const resultBox = document.getElementById('foodAiEstimateResult');

    if (!name.trim()) {
        showNotification('Enter a food name first', 'error');
        return;
    }
    const qtyNum = qty === '' ? null : Number(qty);
    if (qty !== '' && !Number.isFinite(qtyNum)) {
        showNotification('Quantity must be a number', 'error');
        return;
    }

    showLoading();
    try {
        const resp = await fetch('/api/food/estimate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ food_name: name, quantity_value: qtyNum, quantity_unit: unit })
        });
        const out = await resp.json().catch(() => ({}));
        if (!resp.ok) {
            showNotification(out.error || 'Estimate failed', 'error');
            return;
        }

        const est = out.estimated || {};
        if (document.getElementById('foodCalories')) document.getElementById('foodCalories').value = est.calories_kcal ?? '';
        if (document.getElementById('foodProtein')) document.getElementById('foodProtein').value = est.protein_g ?? '';
        if (document.getElementById('foodCarbs')) document.getElementById('foodCarbs').value = est.carbs_g ?? '';
        if (document.getElementById('foodFat')) document.getElementById('foodFat').value = est.fat_g ?? '';

        const servingText = out.quantity_text || (qtyNum != null ? `${qtyNum} ${unit}` : '');
        const servingSize = document.getElementById('servingSize');
        if (servingSize && !servingSize.value) servingSize.value = servingText;

        const conf = out.confidence_0_1 != null ? Math.round(Number(out.confidence_0_1) * 100) : null;
        if (resultBox) {
            resultBox.style.display = 'block';
            resultBox.innerHTML = `
                <div class="info-panel__title">AI estimate</div>
                <div style="color:#6b7280;font-weight:800;">
                    ${escapeHtml(out.food_name || name)}
                    ${servingText ? ' • ' + escapeHtml(servingText) : ''}
                    ${conf != null && Number.isFinite(conf) ? ' • conf ' + conf + '%' : ''}
                </div>
                ${out.notes ? `<div style="margin-top:6px;color:#6b7280;">${escapeHtml(out.notes)}</div>` : ''}
            `;
        }
        showNotification('Estimated macros filled in', 'success');
    } finally {
        hideLoading();
    }
}

function goToFoodScanTool(targetId) {
    try {
        switchTab('food');
        const el = document.getElementById(targetId);
        el?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
        // Pre-fill date to match Food Log date when relevant
        const foodDate = document.getElementById('foodDate')?.value;
        if (foodDate) {
            const d1 = document.getElementById('foodPhotoDate');
            if (d1) d1.value = foodDate;
            const d2 = document.getElementById('foodPackagingDate');
            if (d2) d2.value = foodDate;
        }
    } catch { }
}

async function runGarminDbAutoSync() {
    const box = document.getElementById('garminDbSyncResults');
    const days = Number(document.getElementById('garminDbDays')?.value || 30);
    const includeDaily = !!document.getElementById('garminDbIncludeDaily')?.checked;
    const includeWorkouts = !!document.getElementById('garminDbIncludeWorkouts')?.checked;
    const includeSamples = !!document.getElementById('garminDbIncludeSamples')?.checked;
    const samplesDays = Number(document.getElementById('garminDbSamplesDays')?.value || 7);
    if (box) box.innerHTML = `<div class="journal-item"><div class="journal-item__meta">Running GarminDB sync… (this can take a few minutes)</div></div>`;
    showLoading();
    try {
        const resp = await fetch('/api/garmin/autosync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ days, includeDaily, includeWorkouts, includeSamples, samplesDays })
        });
        const data = await resp.json();
        if (!resp.ok) {
            if (box) box.innerHTML = `<div class="journal-item"><div class="journal-item__meta" style="color:#b91c1c;font-weight:900;">${escapeHtml(data.error || 'Failed')}</div></div>`;
            return;
        }
        if (box) {
            const s = data.summary || {};
            box.innerHTML = `
                <div class="journal-item">
                    <div class="journal-item__header">
                        <div>
                            <div class="journal-item__title">GarminDB Auto Sync complete</div>
                            <div class="journal-item__meta">Imported last ${escapeHtml(String(data.days || ''))} days</div>
                        </div>
                    </div>
                    <div class="pill-row">
                        <span class="pill blue">Activity days ${escapeHtml(String(s.activity_days || 0))}</span>
                        <span class="pill green">Sleep days ${escapeHtml(String(s.sleep_days || 0))}</span>
                        <span class="pill purple">Weight days ${escapeHtml(String(s.weight_days || 0))}</span>
                        <span class="pill red">Resting HR days ${escapeHtml(String(s.resting_hr_days || 0))}</span>
                        <span class="pill">Workouts ${escapeHtml(String(s.workout_sessions || 0))}</span>
                        <span class="pill">HR samples ${escapeHtml(String(s.hr_samples || 0))}</span>
                    </div>
                    <div style="margin-top:10px;color:#6b7280;font-weight:800;">
                        Saved into <b>Sleep</b>, <b>Activity</b>, and <b>Fitness → recent workouts</b>. Also used on the <b>Dashboard</b> charts.
                    </div>
                    <div style="margin-top:10px;display:flex;gap:10px;flex-wrap:wrap;">
                        <button type="button" class="btn btn-secondary" id="garminViewSleepBtn">View Sleep</button>
                        <button type="button" class="btn btn-secondary" id="garminViewActivityBtn">View Activity</button>
                        <button type="button" class="btn btn-secondary" id="garminViewFitnessBtn">View Fitness</button>
                    </div>
                    ${data.note ? `<div style="margin-top:10px;color:#6b7280;font-weight:800;">${escapeHtml(String(data.note))}</div>` : ''}
                </div>
            `;
            // Wire up view buttons
            const viewSleepBtn = document.getElementById('garminViewSleepBtn');
            if (viewSleepBtn) viewSleepBtn.addEventListener('click', () => openTabAndScroll('sleep', 'sleepCard'));
            const viewActivityBtn = document.getElementById('garminViewActivityBtn');
            if (viewActivityBtn) viewActivityBtn.addEventListener('click', () => openTabAndScroll('activity', 'activityCard'));
            const viewFitnessBtn = document.getElementById('garminViewFitnessBtn');
            if (viewFitnessBtn) viewFitnessBtn.addEventListener('click', () => switchTab('fitness'));
        }
        // refresh dashboard/cards
        loadDashboardData();
        refreshBodyComp?.();
        // refresh workouts list if available
        loadRecentWorkouts?.();
    } catch (e) {
        if (box) box.innerHTML = `<div class="journal-item"><div class="journal-item__meta" style="color:#b91c1c;font-weight:900;">Network error running sync</div></div>`;
    } finally {
        hideLoading();
    }
}

function openTabAndScroll(tabId, targetId) {
    try {
        switchTab(tabId);
        const el = document.getElementById(targetId);
        if (el && el.classList.contains('card-content') && !el.classList.contains('expanded')) {
            toggleCard(targetId);
        }
        el?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    } catch { }
}

// Tab Navigation
function switchTab(tabName) {
    // Remove active class from all tabs and content
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));

    // Add active class to selected tab and content
    document.querySelector(`[data-tab="${tabName}"]`).classList.add('active');
    document.getElementById(tabName).classList.add('active');

    // Load data for specific tabs
    if (tabName === 'dashboard') {
        loadDashboardData();
    } else if (tabName === 'analysis') {
        loadAnalysisData();
    } else if (tabName === 'genetic') {
        loadGeneticData();
    } else if (tabName === 'garmin') {
        // Device import tab - load imported data
        loadGarminData();
    } else if (tabName === 'journal') {
        loadJournalList();
    } else if (tabName === 'food') {
        loadFoodPhotos();
    } else if (tabName === 'fitness') {
        refreshExerciseLibrary().catch(() => { });
        refreshFitnessCharts();
        loadRecentWorkouts();
    } else if (tabName === 'insights') {
        refreshWeeklyInsights().catch(() => { });
        loadCheckins().catch(() => { });
    } else if (tabName === 'morning-routine') {
        loadMorningRoutine().catch(() => { });
    } else if (tabName === 'evening-routine') {
        loadEveningRoutine().catch(() => { });
    } else if (tabName === 'bodycomp') {
        refreshBodyComp();
    } else if (tabName === 'trends') {
        loadTrendsTab().catch(() => { });
    } else if (tabName === 'labs') {
        loadLabsTab().catch(() => { });
    } else if (tabName === 'supplements') {
        loadSupplementsDay().catch(() => { });
        loadSupplementRegimens().catch(() => { });
    } else if (tabName === 'medications') {
        loadMedicationsDay().catch(() => { });
        loadMedicationRegimens().catch(() => { });
    }
}

// Insights (weekly report + check-ins)
function mondayForDate(d) {
    const dt = new Date(d);
    dt.setHours(0, 0, 0, 0);
    const day = dt.getDay(); // 0 Sun
    const diff = (day === 0 ? -6 : 1) - day;
    dt.setDate(dt.getDate() + diff);
    return dt.toISOString().split('T')[0];
}

async function refreshWeeklyInsights() {
    const input = document.getElementById('insightsWeekStart');
    if (input && !input.value) {
        input.value = new Date().toISOString().split('T')[0];
    }
    const d = input?.value || new Date().toISOString().split('T')[0];
    const weekStart = mondayForDate(d);
    const box = document.getElementById('weeklyInsightBox');
    if (box) box.innerHTML = `<div class="info-panel__title">Generating…</div><div style="color:#6b7280;font-weight:700;">Week starting ${escapeHtml(weekStart)}</div>`;

    try {
        const resp = await fetch(`/api/insights/week?week_start=${encodeURIComponent(weekStart)}&refresh=true&narrative=true`);
        const data = await resp.json();
        if (!resp.ok) {
            if (box) box.innerHTML = `<div class="info-panel__title">Error</div><div style="color:#b91c1c;font-weight:800;">${escapeHtml(data.error || 'Failed')}</div>`;
            return;
        }
        if (box) {
            // Basic Markdown-ish rendering
            const md = String(data.summary_md || '');
            const html = escapeHtml(md).replaceAll('\n', '<br>');
            box.innerHTML = `<div class="info-panel__title">Weekly report</div><div style="color:#374151; font-weight:700; line-height:1.6;">${html}</div>`;
        }
    } catch (e) {
        if (box) box.innerHTML = `<div class="info-panel__title">Error</div><div style="color:#b91c1c;font-weight:800;">Network error</div>`;
    }
}

async function saveManualCheckin() {
    const mood = document.getElementById('checkinMood')?.value;
    const stress = document.getElementById('checkinStress')?.value;
    const energy = document.getElementById('checkinEnergy')?.value;
    const notes = document.getElementById('checkinNotes')?.value || '';

    const payload = {
        occurred_at: new Date().toISOString(),
        mood_score: mood ? Number(mood) : null,
        stress_score: stress ? Number(stress) : null,
        energy_score: energy ? Number(energy) : null,
        notes: notes || null,
        source: 'web'
    };
    showLoading();
    try {
        const resp = await fetch('/api/checkins', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await resp.json();
        if (!resp.ok) {
            showNotification(data.error || 'Failed to save check-in', 'error');
            return;
        }
        showNotification('Check-in saved', 'success');
        document.getElementById('checkinMood').value = '';
        document.getElementById('checkinStress').value = '';
        document.getElementById('checkinEnergy').value = '';
        document.getElementById('checkinNotes').value = '';
        await loadCheckins();
    } catch (e) {
        showNotification('Network error saving check-in', 'error');
    } finally {
        hideLoading();
    }
}

async function loadCheckins() {
    const box = document.getElementById('checkinsList');
    if (!box) return;
    try {
        const resp = await fetch('/api/checkins?limit=50');
        const rows = await resp.json();
        if (!resp.ok) {
            box.innerHTML = `<div class="journal-item"><div class="journal-item__meta">Error loading check-ins</div></div>`;
            return;
        }
        if (!rows.length) {
            box.innerHTML = `<div class="journal-item"><div class="journal-item__meta">No check-ins yet. Save one above.</div></div>`;
            return;
        }
        box.innerHTML = rows.slice(0, 20).map(r => {
            const when = r.occurred_at ? new Date(r.occurred_at).toLocaleString() : '';
            const pills = [];
            if (r.mood_score != null) pills.push(`<span class="pill blue">Mood ${r.mood_score}</span>`);
            if (r.stress_score != null) pills.push(`<span class="pill red">Stress ${r.stress_score}</span>`);
            if (r.energy_score != null) pills.push(`<span class="pill green">Energy ${r.energy_score}</span>`);
            return `
                <div class="journal-item">
                    <div class="journal-item__header">
                        <div>
                            <div class="journal-item__title">${escapeHtml(when)}</div>
                            <div class="journal-item__meta">${escapeHtml(r.source || 'check-in')}</div>
                        </div>
                    </div>
                    ${pills.length ? `<div class="pill-row">${pills.join('')}</div>` : ''}
                    ${r.notes ? `<div style="margin-top:10px; color:#374151;">${escapeHtml(r.notes)}</div>` : ''}
                </div>
            `;
        }).join('');
    } catch (e) {
        box.innerHTML = `<div class="journal-item"><div class="journal-item__meta">Network error loading check-ins</div></div>`;
    }
}

// Morning routine checklist
function routineSelectedDate() {
    const input = document.getElementById('routineDate');
    const today = new Date().toISOString().split('T')[0];
    if (input && !input.value) input.value = today;
    return input?.value || today;
}

async function loadMorningRoutine() {
    const date = routineSelectedDate();
    const list = document.getElementById('routineChecklist');
    const progress = document.getElementById('routineProgress');
    if (progress) {
        progress.innerHTML = `<div class="info-panel__title">Loading…</div><div style="color:#6b7280;font-weight:700;">${escapeHtml(date)}</div>`;
    }
    if (list) list.innerHTML = '';

    try {
        const resp = await fetch(`/api/routine/day?routine=morning&date=${encodeURIComponent(date)}`);
        const data = await resp.json();
        if (!resp.ok) {
            if (progress) progress.innerHTML = `<div class="info-panel__title">Error</div><div style="color:#b91c1c;font-weight:800;">${escapeHtml(data.error || 'Failed')}</div>`;
            return;
        }

        const items = Array.isArray(data.items) ? data.items : [];
        const done = items.filter(i => i.completed).length;
        const total = items.length;
        const pct = total ? Math.round((done / total) * 100) : 0;

        if (progress) {
            progress.innerHTML = `
                <div class="info-panel__title">Progress</div>
                <div class="routine-progress-row">
                    <div class="routine-progress-text">${done} / ${total} complete</div>
                    <div class="routine-progress-bar"><div class="routine-progress-fill" style="width:${pct}%"></div></div>
                    <div class="routine-progress-pct">${pct}%</div>
                </div>
            `;
        }

        if (!list) return;
        if (!items.length) {
            list.innerHTML = `<div class="routine-empty">No items yet. Add a few below.</div>`;
            return;
        }

        list.innerHTML = items.map(i => {
            const kind = String(i.kind || 'check');
            const completedAt = i.completed_at ? new Date(i.completed_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
            const valueUpdatedAt = i.value_updated_at ? new Date(i.value_updated_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
            const unit = i.value_unit ? String(i.value_unit) : '';

            let controlHtml = '';
            if (kind === 'yesno') {
                const v = (i.value_text || '').toLowerCase();
                const yesActive = v === 'yes' ? 'active' : '';
                const noActive = v === 'no' ? 'active' : '';
                controlHtml = `
                    <div class="routine-yesno" data-id="${i.id}">
                        <button type="button" class="routine-yesno-btn ${yesActive}" data-value="yes" data-id="${i.id}">Yes</button>
                        <button type="button" class="routine-yesno-btn ${noActive}" data-value="no" data-id="${i.id}">No</button>
                    </div>
                `;
            } else if (kind === 'number') {
                const v = (i.value_num ?? '') === null ? '' : (i.value_num ?? '');
                const step = i.value_step != null ? Number(i.value_step) : 'any';
                controlHtml = `
                    <div class="routine-number">
                        <input type="number" class="routine-number-input" data-id="${i.id}" value="${escapeHtml(String(v))}" step="${escapeHtml(String(step))}" placeholder="0" />
                        ${unit ? `<span class="routine-unit">${escapeHtml(unit)}</span>` : ''}
                    </div>
                `;
            } else if (kind === 'text') {
                const v = i.value_text ?? '';
                controlHtml = `<input type="text" class="routine-text-input" data-id="${i.id}" value="${escapeHtml(String(v))}" placeholder="Enter…" />`;
            } else if (kind === 'time') {
                const v = i.value_text ?? '';
                controlHtml = `<input type="time" class="routine-time-input" data-id="${i.id}" value="${escapeHtml(String(v))}" />`;
            } else {
                controlHtml = `<span style="color:#b91c1c;font-weight:900;">Unknown type</span>`;
            }

            const meta =
                kind === 'yesno'
                    ? (i.value_text ? `Answered ${escapeHtml(String(i.value_text).toUpperCase())}` : '')
                    : (i.completed ? (valueUpdatedAt ? `Saved ${escapeHtml(valueUpdatedAt)}` : 'Saved') : '');

            return `
                <div class="routine-item" data-id="${i.id}">
                    <div class="routine-left">
                        <div class="routine-title">${escapeHtml(i.title || '')}</div>
                        <div class="routine-control">${controlHtml}</div>
                    </div>
                    <div class="routine-meta">${meta}</div>
                    <div class="routine-actions">
                        <button type="button" class="btn btn-secondary routine-btn" data-action="rename" data-id="${i.id}">
                            <i class="fas fa-pen"></i>
                        </button>
                        <button type="button" class="btn btn-secondary routine-btn" data-action="delete" data-id="${i.id}">
                            <i class="fas fa-trash"></i>
                        </button>
                    </div>
                </div>
            `;
        }).join('');

        // Wire handlers (Yes/No)
        list.querySelectorAll('.routine-yesno-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const itemId = Number(e.currentTarget.dataset.id);
                const value = String(e.currentTarget.dataset.value || '').toLowerCase();
                // clicking active again clears
                const wrap = e.currentTarget.closest('.routine-yesno');
                const isActive = e.currentTarget.classList.contains('active');
                await saveRoutineValue({ routine: 'morning', date, itemId, value_text: isActive ? '' : value });
            });
        });

        // Debounced value saving (number/text)
        const debouncers = new Map();
        function debounceKey(id) { return `k:${id}`; }
        function debounce(id, fn, wait = 500) {
            const key = debounceKey(id);
            const prev = debouncers.get(key);
            if (prev) clearTimeout(prev);
            debouncers.set(key, setTimeout(fn, wait));
        }

        list.querySelectorAll('.routine-number-input').forEach(inp => {
            inp.addEventListener('input', (e) => {
                const itemId = Number(e.target.dataset.id);
                const raw = e.target.value;
                debounce(itemId, async () => {
                    await saveRoutineValue({ routine: 'morning', date, itemId, value_num: raw, inputEl: e.target });
                });
            });
        });

        list.querySelectorAll('.routine-text-input').forEach(inp => {
            inp.addEventListener('input', (e) => {
                const itemId = Number(e.target.dataset.id);
                const raw = e.target.value;
                debounce(itemId, async () => {
                    await saveRoutineValue({ routine: 'morning', date, itemId, value_text: raw, inputEl: e.target });
                });
            });
        });

        list.querySelectorAll('.routine-time-input').forEach(inp => {
            inp.addEventListener('input', (e) => {
                const itemId = Number(e.target.dataset.id);
                const raw = e.target.value; // HH:MM or ''
                debounce(itemId, async () => {
                    await saveRoutineValue({ routine: 'morning', date, itemId, value_text: raw, inputEl: e.target });
                });
            });
        });

        list.querySelectorAll('.routine-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const action = e.currentTarget.dataset.action;
                const itemId = Number(e.currentTarget.dataset.id);
                if (action === 'delete') {
                    await deleteRoutineItem(itemId, 'morning');
                } else if (action === 'rename') {
                    await renameRoutineItem(itemId, 'morning');
                }
            });
        });
    } catch (e) {
        if (progress) progress.innerHTML = `<div class="info-panel__title">Error</div><div style="color:#b91c1c;font-weight:800;">Network error</div>`;
    }
}

async function saveRoutineValue({ routine = 'morning', date, itemId, value_num, value_text, inputEl }) {
    try {
        const payload = { routine, date, item_id: itemId };
        if (value_num !== undefined) payload.value_num = value_num === '' ? '' : Number(value_num);
        if (value_text !== undefined) payload.value_text = value_text;
        const resp = await fetch('/api/routine/day/value', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await resp.json();
        if (!resp.ok) {
            showNotification(data.error || 'Failed to save value', 'error');
            return;
        }
        // Keep UI fresh (progress/meta updates)
        if (routine === 'evening') await loadEveningRoutine();
        else await loadMorningRoutine();
    } catch {
        showNotification('Network error saving value', 'error');
    }
}

async function seedRoutineMetrics() {
    showLoading();
    try {
        const resp = await fetch('/api/routine/templates/morning-metrics', { method: 'POST' });
        const data = await resp.json();
        if (!resp.ok) {
            showNotification(data.error || 'Failed to add metrics', 'error');
            return;
        }
        showNotification(`Added ${data.created || 0} items`, 'success');
        await loadMorningRoutine();
    } catch {
        showNotification('Network error adding metrics', 'error');
    } finally {
        hideLoading();
    }
}

function eveningRoutineSelectedDate() {
    const input = document.getElementById('eveningRoutineDate');
    const today = new Date().toISOString().split('T')[0];
    if (input && !input.value) input.value = today;
    return input?.value || today;
}

async function loadEveningRoutine() {
    const date = eveningRoutineSelectedDate();
    const list = document.getElementById('eveningRoutineChecklist');
    const progress = document.getElementById('eveningRoutineProgress');
    if (progress) {
        progress.innerHTML = `<div class="info-panel__title">Loading…</div><div style="color:#6b7280;font-weight:700;">${escapeHtml(date)}</div>`;
    }
    if (list) list.innerHTML = '';

    try {
        const resp = await fetch(`/api/routine/day?routine=evening&date=${encodeURIComponent(date)}`);
        const data = await resp.json();
        if (!resp.ok) {
            if (progress) progress.innerHTML = `<div class="info-panel__title">Error</div><div style="color:#b91c1c;font-weight:800;">${escapeHtml(data.error || 'Failed')}</div>`;
            return;
        }

        const items = Array.isArray(data.items) ? data.items : [];
        const done = items.filter(i => i.completed).length;
        const total = items.length;
        const pct = total ? Math.round((done / total) * 100) : 0;

        if (progress) {
            progress.innerHTML = `
                <div class="info-panel__title">Progress</div>
                <div class="routine-progress-row">
                    <div class="routine-progress-text">${done} / ${total} complete</div>
                    <div class="routine-progress-bar"><div class="routine-progress-fill" style="width:${pct}%"></div></div>
                    <div class="routine-progress-pct">${pct}%</div>
                </div>
            `;
        }

        if (!list) return;
        if (!items.length) {
            list.innerHTML = `<div class="routine-empty">No items yet. Add a few below.</div>`;
            return;
        }

        // Reuse the same rendering logic as morning by temporarily injecting into DOM and wiring handlers
        list.innerHTML = items.map(i => {
            const kind = String(i.kind || 'check');
            const completedAt = i.completed_at ? new Date(i.completed_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
            const valueUpdatedAt = i.value_updated_at ? new Date(i.value_updated_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
            const unit = i.value_unit ? String(i.value_unit) : '';

            let controlHtml = '';
            if (kind === 'yesno') {
                const v = (i.value_text || '').toLowerCase();
                const yesActive = v === 'yes' ? 'active' : '';
                const noActive = v === 'no' ? 'active' : '';
                controlHtml = `
                    <div class="routine-yesno" data-id="${i.id}">
                        <button type="button" class="routine-yesno-btn ${yesActive}" data-value="yes" data-id="${i.id}">Yes</button>
                        <button type="button" class="routine-yesno-btn ${noActive}" data-value="no" data-id="${i.id}">No</button>
                    </div>
                `;
            } else if (kind === 'number') {
                const v = (i.value_num ?? '') === null ? '' : (i.value_num ?? '');
                const step = i.value_step != null ? Number(i.value_step) : 'any';
                controlHtml = `
                    <div class="routine-number">
                        <input type="number" class="routine-number-input" data-id="${i.id}" value="${escapeHtml(String(v))}" step="${escapeHtml(String(step))}" placeholder="0" />
                        ${unit ? `<span class="routine-unit">${escapeHtml(unit)}</span>` : ''}
                    </div>
                `;
            } else if (kind === 'text') {
                const v = i.value_text ?? '';
                controlHtml = `<input type="text" class="routine-text-input" data-id="${i.id}" value="${escapeHtml(String(v))}" placeholder="Enter…" />`;
            } else if (kind === 'time') {
                const v = i.value_text ?? '';
                controlHtml = `<input type="time" class="routine-time-input" data-id="${i.id}" value="${escapeHtml(String(v))}" />`;
            } else {
                controlHtml = `<span style="color:#b91c1c;font-weight:900;">Unknown type</span>`;
            }

            const meta =
                kind === 'yesno'
                    ? (i.value_text ? `Answered ${escapeHtml(String(i.value_text).toUpperCase())}` : '')
                    : (i.completed ? (valueUpdatedAt ? `Saved ${escapeHtml(valueUpdatedAt)}` : 'Saved') : '');

            return `
                <div class="routine-item" data-id="${i.id}">
                    <div class="routine-left">
                        <div class="routine-title">${escapeHtml(i.title || '')}</div>
                        <div class="routine-control">${controlHtml}</div>
                    </div>
                    <div class="routine-meta">${meta}</div>
                    <div class="routine-actions">
                        <button type="button" class="btn btn-secondary routine-btn" data-action="rename" data-id="${i.id}">
                            <i class="fas fa-pen"></i>
                        </button>
                        <button type="button" class="btn btn-secondary routine-btn" data-action="delete" data-id="${i.id}">
                            <i class="fas fa-trash"></i>
                        </button>
                    </div>
                </div>
            `;
        }).join('');

        // Wire handlers (Yes/No)
        list.querySelectorAll('.routine-yesno-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const itemId = Number(e.currentTarget.dataset.id);
                const value = String(e.currentTarget.dataset.value || '').toLowerCase();
                const isActive = e.currentTarget.classList.contains('active');
                await saveRoutineValue({ routine: 'evening', date, itemId, value_text: isActive ? '' : value });
            });
        });

        const debouncers = new Map();
        function debounceKey(id) { return `k:${id}`; }
        function debounce(id, fn, wait = 500) {
            const key = debounceKey(id);
            const prev = debouncers.get(key);
            if (prev) clearTimeout(prev);
            debouncers.set(key, setTimeout(fn, wait));
        }

        list.querySelectorAll('.routine-number-input').forEach(inp => {
            inp.addEventListener('input', (e) => {
                const itemId = Number(e.target.dataset.id);
                const raw = e.target.value;
                debounce(itemId, async () => {
                    await saveRoutineValue({ routine: 'evening', date, itemId, value_num: raw, inputEl: e.target });
                });
            });
        });
        list.querySelectorAll('.routine-text-input').forEach(inp => {
            inp.addEventListener('input', (e) => {
                const itemId = Number(e.target.dataset.id);
                const raw = e.target.value;
                debounce(itemId, async () => {
                    await saveRoutineValue({ routine: 'evening', date, itemId, value_text: raw, inputEl: e.target });
                });
            });
        });
        list.querySelectorAll('.routine-time-input').forEach(inp => {
            inp.addEventListener('input', (e) => {
                const itemId = Number(e.target.dataset.id);
                const raw = e.target.value;
                debounce(itemId, async () => {
                    await saveRoutineValue({ routine: 'evening', date, itemId, value_text: raw, inputEl: e.target });
                });
            });
        });

        list.querySelectorAll('.routine-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const action = e.currentTarget.dataset.action;
                const itemId = Number(e.currentTarget.dataset.id);
                if (action === 'delete') {
                    await deleteRoutineItem(itemId, 'evening');
                } else if (action === 'rename') {
                    await renameRoutineItem(itemId, 'evening');
                }
            });
        });
    } catch (e) {
        if (progress) progress.innerHTML = `<div class="info-panel__title">Error</div><div style="color:#b91c1c;font-weight:800;">Network error</div>`;
    }
}

async function seedEveningRoutine() {
    showLoading();
    try {
        const resp = await fetch('/api/routine/templates/evening-routine', { method: 'POST' });
        const data = await resp.json();
        if (!resp.ok) {
            showNotification(data.error || 'Failed to add items', 'error');
            return;
        }
        showNotification(`Added ${data.created || 0} items`, 'success');
        await loadEveningRoutine();
    } catch {
        showNotification('Network error adding items', 'error');
    } finally {
        hideLoading();
    }
}

// Legacy checkbox toggles are deprecated; yes/no uses saveRoutineValue()

async function handleRoutineAddItem(e) {
    e.preventDefault();
    const input = document.getElementById('routineItemTitle');
    const title = input?.value || '';
    const kind = document.getElementById('routineItemKind')?.value || 'yesno';
    const valueUnit = document.getElementById('routineItemUnit')?.value || '';
    const valueKey = document.getElementById('routineItemKey')?.value || '';
    const valueStep = document.getElementById('routineItemStep')?.value;
    showLoading();
    try {
        const resp = await fetch('/api/routine/items', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                routine: 'morning',
                title,
                kind,
                value_unit: valueUnit || null,
                value_key: valueKey || null,
                value_step: valueStep ? Number(valueStep) : null
            })
        });
        const data = await resp.json();
        if (!resp.ok) {
            showNotification(data.error || 'Failed to add item', 'error');
            return;
        }
        if (input) input.value = '';
        const unitEl = document.getElementById('routineItemUnit');
        const keyEl = document.getElementById('routineItemKey');
        const stepEl = document.getElementById('routineItemStep');
        if (unitEl) unitEl.value = '';
        if (keyEl) keyEl.value = '';
        if (stepEl) stepEl.value = '';
        showNotification('Routine item added', 'success');
        await loadMorningRoutine();
    } catch (e2) {
        showNotification('Network error adding item', 'error');
    } finally {
        hideLoading();
    }
}

async function renameRoutineItem(itemId, routine = 'morning') {
    const row = document.querySelector(`.routine-item[data-id="${itemId}"] .routine-title`);
    const current = row ? row.textContent : '';
    const next = prompt('Rename item', current || '');
    if (next == null) return;
    showLoading();
    try {
        const resp = await fetch(`/api/routine/items/${itemId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: next })
        });
        const data = await resp.json();
        if (!resp.ok) {
            showNotification(data.error || 'Failed to rename item', 'error');
            return;
        }
        showNotification('Renamed', 'success');
        if (routine === 'evening') await loadEveningRoutine();
        else await loadMorningRoutine();
    } catch {
        showNotification('Network error renaming item', 'error');
    } finally {
        hideLoading();
    }
}

async function deleteRoutineItem(itemId, routine = 'morning') {
    const ok = confirm('Delete this routine item?');
    if (!ok) return;
    showLoading();
    try {
        const resp = await fetch(`/api/routine/items/${itemId}`, { method: 'DELETE' });
        const data = await resp.json();
        if (!resp.ok) {
            showNotification(data.error || 'Failed to delete item', 'error');
            return;
        }
        showNotification('Deleted', 'success');
        if (routine === 'evening') await loadEveningRoutine();
        else await loadMorningRoutine();
    } catch {
        showNotification('Network error deleting item', 'error');
    } finally {
        hideLoading();
    }
}

async function handleEveningRoutineAddItem(e) {
    e.preventDefault();
    const input = document.getElementById('eveningRoutineItemTitle');
    const title = input?.value || '';
    const kind = document.getElementById('eveningRoutineItemKind')?.value || 'yesno';
    const valueUnit = document.getElementById('eveningRoutineItemUnit')?.value || '';
    const valueKey = document.getElementById('eveningRoutineItemKey')?.value || '';
    const valueStep = document.getElementById('eveningRoutineItemStep')?.value;
    showLoading();
    try {
        const resp = await fetch('/api/routine/items', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                routine: 'evening',
                title,
                kind,
                value_unit: valueUnit || null,
                value_key: valueKey || null,
                value_step: valueStep ? Number(valueStep) : null
            })
        });
        const data = await resp.json();
        if (!resp.ok) {
            showNotification(data.error || 'Failed to add item', 'error');
            return;
        }
        if (input) input.value = '';
        const unitEl = document.getElementById('eveningRoutineItemUnit');
        const keyEl = document.getElementById('eveningRoutineItemKey');
        const stepEl = document.getElementById('eveningRoutineItemStep');
        if (unitEl) unitEl.value = '';
        if (keyEl) keyEl.value = '';
        if (stepEl) stepEl.value = '';
        showNotification('Evening item added', 'success');
        await loadEveningRoutine();
    } catch {
        showNotification('Network error adding item', 'error');
    } finally {
        hideLoading();
    }
}

// Journal
async function handleJournalSubmit(e) {
    e.preventDefault();
    showLoading();
    const date = document.getElementById('journalDate').value;
    const title = document.getElementById('journalTitle').value;
    const content = document.getElementById('journalContent').value;
    const runInsights = document.getElementById('journalRunInsights').checked;

    try {
        const response = await fetch('/api/journal', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ date, title, content, run_insights: runInsights })
        });
        const result = await response.json();
        if (!response.ok) {
            showNotification(result.error || 'Error saving journal', 'error');
            return;
        }

        showNotification('Journal saved', 'success');
        if (result.insights) {
            renderLatestJournalInsights(result.insights);
        }
        await loadJournalList();
    } catch (err) {
        showNotification('Network error saving journal', 'error');
    } finally {
        hideLoading();
    }
}

async function handleJournalAnalyze() {
    const date = document.getElementById('journalDate').value;
    if (!date) {
        showNotification('Select a journal date first', 'error');
        return;
    }
    showLoading();
    try {
        const response = await fetch(`/api/journal/${date}/analyze`, { method: 'POST' });
        const result = await response.json();
        if (!response.ok) {
            showNotification(result.error || 'Error analyzing journal', 'error');
            return;
        }
        showNotification('Journal analyzed', 'success');
        renderLatestJournalInsights(result.insights);
        await loadJournalList();
    } catch (err) {
        showNotification('Network error analyzing journal', 'error');
    } finally {
        hideLoading();
    }
}

function renderLatestJournalInsights(insights) {
    const box = document.getElementById('journalLatestInsights');
    if (!box) return;
    box.style.display = 'block';

    const tags = Array.isArray(insights.tags) ? insights.tags : [];
    box.innerHTML = `
        <div class="info-panel__title">Extracted Signals</div>
        <div class="info-grid">
            <div class="info-metric">
                <div class="info-metric__label">Mood</div>
                <div class="info-metric__value">${insights.mood_score ?? '-'} / 10</div>
            </div>
            <div class="info-metric">
                <div class="info-metric__label">Energy</div>
                <div class="info-metric__value">${insights.energy_score ?? '-'} / 10</div>
            </div>
            <div class="info-metric">
                <div class="info-metric__label">Stress</div>
                <div class="info-metric__value">${insights.stress_score ?? '-'} / 10</div>
            </div>
            <div class="info-metric">
                <div class="info-metric__label">Anxiety</div>
                <div class="info-metric__value">${insights.anxiety_score ?? '-'} / 10</div>
            </div>
        </div>
        ${tags.length ? `
            <div class="pill-row" style="margin-top: 14px;">
                ${tags.map(t => `<span class="pill blue">${t}</span>`).join('')}
            </div>
        ` : ''}
    `;
}

async function loadJournalList() {
    const list = document.getElementById('journalList');
    if (!list) return;

    try {
        const response = await fetch('/api/journal');
        const entries = await response.json();
        if (!response.ok) {
            list.innerHTML = `<div class="journal-item"><div class="journal-item__meta">Error loading journal: ${entries.error || 'unknown'}</div></div>`;
            return;
        }

        if (!entries.length) {
            list.innerHTML = `
                <div class="journal-item">
                    <div class="journal-item__title">No entries yet</div>
                    <div class="journal-item__meta">Write your first daily journal entry above.</div>
                </div>
            `;
            return;
        }

        list.innerHTML = entries.slice(0, 14).map(e => {
            const pills = [];
            if (e.mood_score != null) pills.push(`<span class="pill green">Mood ${e.mood_score}/10</span>`);
            if (e.energy_score != null) pills.push(`<span class="pill blue">Energy ${e.energy_score}/10</span>`);
            if (e.stress_score != null) pills.push(`<span class="pill orange">Stress ${e.stress_score}/10</span>`);
            if (e.anxiety_score != null) pills.push(`<span class="pill red">Anxiety ${e.anxiety_score}/10</span>`);

            const title = e.title || 'Untitled';
            return `
                <div class="journal-item">
                    <div class="journal-item__header">
                        <div>
                            <div class="journal-item__title">${escapeHtml(title)}</div>
                            <div class="journal-item__meta">${new Date(e.date).toLocaleDateString()}</div>
                        </div>
                        <button class="btn btn-secondary" style="padding:8px 12px;" onclick="loadJournalIntoForm('${e.date}')">
                            <i class="fas fa-pen"></i> Edit
                        </button>
                    </div>
                    ${e.summary ? `<div style="margin-top:10px; color:#374151;">${escapeHtml(e.summary)}</div>` : ''}
                    ${pills.length ? `<div class="pill-row">${pills.join('')}</div>` : ''}
                </div>
            `;
        }).join('');
    } catch (err) {
        list.innerHTML = `<div class="journal-item"><div class="journal-item__meta">Network error loading journal.</div></div>`;
    }
}

async function loadJournalIntoForm(date) {
    showLoading();
    try {
        const response = await fetch(`/api/journal/${date}`);
        const result = await response.json();
        if (!response.ok) {
            showNotification(result.error || 'Error loading entry', 'error');
            return;
        }
        document.getElementById('journalDate').value = result.date;
        document.getElementById('journalTitle').value = result.title || '';
        document.getElementById('journalContent').value = result.content || '';

        if (result.insights && result.insights.length) {
            const latest = result.insights[0];
            renderLatestJournalInsights({
                mood_score: latest.mood_score,
                energy_score: latest.energy_score,
                stress_score: latest.stress_score,
                anxiety_score: latest.anxiety_score,
                tags: latest.tags || []
            });
        }

        showNotification('Loaded entry into editor', 'info');
    } catch (err) {
        showNotification('Network error loading entry', 'error');
    } finally {
        hideLoading();
    }
}

function escapeHtml(str) {
    return (str || '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

window.loadJournalIntoForm = loadJournalIntoForm;

// Food Photo Logging
async function handleFoodPhotoUpload(e) {
    e.preventDefault();

    const date = document.getElementById('foodPhotoDate').value;
    const fileInput = document.getElementById('foodPhotoFile');
    const file = fileInput.files[0];
    const notes = document.getElementById('foodPhotoNotes').value;
    const addToNutrition = document.getElementById('foodPhotoAddToNutrition').checked;
    const addToFoodLog = document.getElementById('foodPhotoAddToFoodLog').checked;

    if (!file) {
        showNotification('Please choose a food photo', 'error');
        return;
    }

    showLoading();
    const formData = new FormData();
    formData.append('date', date);
    formData.append('notes', notes);
    formData.append('addToNutrition', String(addToNutrition));
    formData.append('addToFoodLog', String(addToFoodLog));
    formData.append('photo', file);

    try {
        const response = await fetch('/api/food-photo/upload', {
            method: 'POST',
            body: formData
        });
        const result = await response.json();
        if (!response.ok) {
            showNotification(result.error || 'Upload failed', 'error');
            return;
        }
        showNotification('Food photo analyzed', 'success');
        renderFoodPhotoResult(result);
        e.target.reset();
        setDefaultDates();
        await loadFoodPhotos();
        // Refresh dashboard charts if visible
        if (document.getElementById('dashboard').classList.contains('active')) {
            loadDashboardData();
        }
    } catch (err) {
        showNotification('Network error uploading photo', 'error');
    } finally {
        hideLoading();
    }
}

async function handleFoodPackagingUpload(e) {
    e.preventDefault();

    const date = document.getElementById('foodPackagingDate')?.value;
    const gtin = document.getElementById('foodPackagingGtin')?.value || '';
    const notes = document.getElementById('foodPackagingNotes')?.value || '';
    const model = document.getElementById('foodPackagingModel')?.value || '';
    const addToNutrition = !!document.getElementById('foodPackagingAddToNutrition')?.checked;
    const addToFoodLog = !!document.getElementById('foodPackagingAddToFoodLog')?.checked;
    const inputFiles = Array.from(document.getElementById('foodPackagingFiles')?.files || []);
    const files = [...inputFiles, ...foodPackagingExtraFiles].slice(0, 6);

    if (!date) {
        showNotification('Pick a date', 'error');
        return;
    }
    if (!files.length) {
        showNotification('Please add packaging photos (upload, paste, or drop)', 'error');
        return;
    }

    showLoading();
    const formData = new FormData();
    formData.append('date', date);
    formData.append('gtin', gtin);
    formData.append('notes', notes);
    formData.append('model', model);
    formData.append('addToNutrition', String(addToNutrition));
    formData.append('addToFoodLog', String(addToFoodLog));
    for (const f of files) formData.append('photos', f);

    try {
        const response = await fetch('/api/food-packaging/analyze', {
            method: 'POST',
            body: formData
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) {
            showNotification(result.error || 'Packaging analysis failed', 'error');
            return;
        }
        showNotification('Packaging analyzed', 'success');
        renderFoodPackagingResult(result);
        e.target.reset();
        foodPackagingExtraFiles = [];
        renderFoodPackagingPreviews();
        setDefaultDates();
        // Refresh dashboard if visible
        if (document.getElementById('dashboard').classList.contains('active')) {
            loadDashboardData();
        }
    } catch (err) {
        showNotification('Network error analyzing packaging', 'error');
    } finally {
        hideLoading();
    }
}

function setupFoodPackagingPaste() {
    const zone = document.getElementById('foodPackagingPasteZone');
    const clearBtn = document.getElementById('foodPackagingClearPhotosBtn');
    const fileInput = document.getElementById('foodPackagingFiles');
    if (!zone) return;

    const prevent = (e) => { e.preventDefault(); e.stopPropagation(); };
    zone.addEventListener('click', () => zone.focus());

    zone.addEventListener('dragover', (e) => { prevent(e); zone.classList.add('dragover'); });
    zone.addEventListener('dragleave', (e) => { prevent(e); zone.classList.remove('dragover'); });
    zone.addEventListener('drop', (e) => {
        prevent(e);
        zone.classList.remove('dragover');
        const files = Array.from(e.dataTransfer?.files || []).filter(f => f && f.type && f.type.startsWith('image/'));
        files.forEach(addFoodPackagingFile);
        renderFoodPackagingPreviews();
    });

    zone.addEventListener('paste', (e) => {
        const items = Array.from(e.clipboardData?.items || []);
        let added = 0;
        for (const it of items) {
            if (!it?.type?.startsWith('image/')) continue;
            const blob = it.getAsFile();
            if (!blob) continue;
            const file = new File([blob], `pasted-${Date.now()}-${Math.random().toString(16).slice(2)}.png`, { type: blob.type || 'image/png' });
            addFoodPackagingFile(file);
            added++;
        }
        if (!added) {
            showNotification('Clipboard does not contain an image', 'error');
            return;
        }
        renderFoodPackagingPreviews();
    });

    if (fileInput) {
        fileInput.addEventListener('change', () => {
            renderFoodPackagingPreviews();
        });
    }

    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            foodPackagingExtraFiles = [];
            if (fileInput) fileInput.value = '';
            renderFoodPackagingPreviews();
        });
    }

    // Initial render
    renderFoodPackagingPreviews();
}

async function loadFoodPackagingModels() {
    const sel = document.getElementById('foodPackagingModel');
    if (!sel) return;

    const fmtMoney = (v) => {
        if (!Number.isFinite(v)) return null;
        // show 0 as 0.00
        return `$${v.toFixed(v < 1 ? 2 : 2)}`;
    };
    const fmtPer1M = (perTokenStr) => {
        const n = Number(perTokenStr);
        if (!Number.isFinite(n)) return null;
        return n * 1_000_000;
    };
    const labelFor = (m) => {
        const p = m.pricing || {};
        const in1m = fmtPer1M(p.prompt);
        const out1m = fmtPer1M(p.completion);

        const parts = [];
        if (in1m != null) parts.push(`${fmtMoney(in1m)} in/1M`);
        if (out1m != null) parts.push(`${fmtMoney(out1m)} out/1M`);
        if (Number.isFinite(Number(p.request)) && Number(p.request) > 0) parts.push(`${fmtMoney(Number(p.request))}/req`);
        if (Number.isFinite(Number(p.image)) && Number(p.image) > 0) parts.push(`${fmtMoney(Number(p.image))}/image`);
        const price = parts.length ? ` — ${parts.join(' • ')}` : '';
        const name = m.name ? `${m.name} (${m.id})` : m.id;
        return `${name}${price}`;
    };

    sel.innerHTML = `<option value="">Loading models…</option>`;
    try {
        const resp = await fetch('/api/llm/models');
        const data = await resp.json().catch(() => ({}));
        const models = Array.isArray(data.models) ? data.models : [];
        const defaultModel = data.defaultModel || '';

        // Recommended at top (vision/OCR strong)
        const recommendedIds = [
            'openai/gpt-4o',
            'anthropic/claude-3.5-sonnet',
            'openai/gpt-4o-mini',
            'google/gemini-2.0-flash',
            'google/gemini-1.5-pro'
        ];
        const byId = new Map(models.map(m => [m.id, m]));
        const recommended = recommendedIds.map(id => byId.get(id)).filter(Boolean);
        const rest = models.filter(m => !recommendedIds.includes(m.id));

        sel.innerHTML = '';
        const addOptGroup = (label, list) => {
            const og = document.createElement('optgroup');
            og.label = label;
            for (const m of list) {
                const opt = document.createElement('option');
                opt.value = m.id;
                opt.textContent = labelFor(m);
                og.appendChild(opt);
            }
            sel.appendChild(og);
        };
        if (recommended.length) addOptGroup('Recommended (best for packaging OCR)', recommended);
        if (rest.length) addOptGroup('All image-capable models', rest);

        // select default
        const wanted = defaultModel && byId.has(defaultModel) ? defaultModel : (recommended[0]?.id || '');
        if (wanted) sel.value = wanted;
    } catch (e) {
        // Fallback: show a short hardcoded list (no live pricing)
        sel.innerHTML = `
            <option value="openai/gpt-4o">openai/gpt-4o</option>
            <option value="anthropic/claude-3.5-sonnet">anthropic/claude-3.5-sonnet</option>
            <option value="openai/gpt-4o-mini">openai/gpt-4o-mini</option>
        `;
        sel.value = 'openai/gpt-4o-mini';
    }
}

function addFoodPackagingFile(file) {
    if (!file || !file.type || !file.type.startsWith('image/')) return;
    const inputCount = document.getElementById('foodPackagingFiles')?.files?.length || 0;
    const currentCount = foodPackagingExtraFiles.length + inputCount;
    if (currentCount >= 6) {
        showNotification('Max 6 photos', 'error');
        return;
    }
    foodPackagingExtraFiles.push(file);
}

function renderFoodPackagingPreviews() {
    const preview = document.getElementById('foodPackagingPreview');
    if (!preview) return;

    // Cleanup old URLs
    for (const u of foodPackagingPreviewUrls) {
        try { URL.revokeObjectURL(u); } catch { }
    }
    foodPackagingPreviewUrls = [];

    const inputFiles = Array.from(document.getElementById('foodPackagingFiles')?.files || []);
    const files = [...inputFiles, ...foodPackagingExtraFiles].slice(0, 6);
    if (!files.length) {
        preview.innerHTML = '';
        return;
    }

    preview.innerHTML = files.map((f, idx) => {
        const url = URL.createObjectURL(f);
        foodPackagingPreviewUrls.push(url);
        const isExtra = idx >= inputFiles.length;
        const extraIdx = isExtra ? (idx - inputFiles.length) : -1;
        const removeAttr = isExtra ? `data-packaging-remove="${extraIdx}"` : `data-packaging-remove-input="1"`;
        return `
            <div class="photo-preview-item">
                <img src="${url}" alt="Packaging photo preview">
                <button type="button" class="photo-preview-remove" ${removeAttr} title="Remove">×</button>
            </div>
        `;
    }).join('');

    preview.querySelectorAll('button[data-packaging-remove]').forEach(btn => {
        btn.addEventListener('click', () => {
            const i = Number(btn.getAttribute('data-packaging-remove'));
            if (Number.isFinite(i) && i >= 0) foodPackagingExtraFiles.splice(i, 1);
            renderFoodPackagingPreviews();
        });
    });
    preview.querySelectorAll('button[data-packaging-remove-input]').forEach(btn => {
        btn.addEventListener('click', () => {
            showNotification('To remove a file-picked photo, re-open the picker and reselect.', 'error');
        });
    });
}

function renderFoodPackagingResult(result) {
    const box = document.getElementById('foodPackagingResult');
    if (!box) return;
    box.style.display = 'block';
    const a = result.analysis || {};
    const n = a.nutrition || {};
    const per = n.per_serving || {};
    const per100 = n.per_100g || {};
    const hasAnyMacros = (obj) => {
        if (!obj || typeof obj !== 'object') return false;
        return ['protein_g', 'carbs_g', 'fat_g', 'sugar_g'].some(k => obj[k] != null && obj[k] !== '');
    };
    // UK sites often only provide per-100g values; fall back to those for display.
    const macroBase = hasAnyMacros(per) ? per : per100;
    const macroLabel = hasAnyMacros(per) ? 'per serving' : 'per 100g';
    box.innerHTML = `
        <div class="info-panel__title">${escapeHtml(a.product_name || 'Packaging analysis')}</div>
        <div style="color:#6b7280; font-weight:700; margin-bottom:10px;">
            ${a.brand ? escapeHtml(a.brand) + ' • ' : ''}${a.serving_size ? 'Serving: ' + escapeHtml(a.serving_size) : ''}
            ${result.gtin ? ' • GTIN ' + escapeHtml(result.gtin) : ''}
        </div>
        <div class="pill-row">
            ${per.calories_kcal != null ? `<span class="pill orange">${escapeHtml(String(per.calories_kcal))} kcal/serving</span>` : ''}
            ${per100.calories_kcal != null ? `<span class="pill"> ${escapeHtml(String(per100.calories_kcal))} kcal/100g</span>` : ''}
            ${a.confidence_0_1 != null ? `<span class="pill blue">conf ${Math.round(Number(a.confidence_0_1) * 100)}%</span>` : ''}
            ${(hasAnyMacros(per) || hasAnyMacros(per100)) ? `<span class="pill">${escapeHtml(macroLabel)}</span>` : ''}
        </div>
        ${a.ingredients ? `<div style="margin-top:12px; color:#374151;"><strong>Ingredients:</strong> ${escapeHtml(a.ingredients)}</div>` : ''}
        ${a.allergens ? `<div style="margin-top:10px; color:#374151;"><strong>Allergens:</strong> ${escapeHtml(a.allergens)}</div>` : ''}
        <div style="margin-top:12px;">
            <div class="info-grid">
                <div class="info-metric"><div class="info-metric__label">Protein</div><div class="info-metric__value">${macroBase.protein_g ?? '-'} g</div></div>
                <div class="info-metric"><div class="info-metric__label">Carbs</div><div class="info-metric__value">${macroBase.carbs_g ?? '-'} g</div></div>
                <div class="info-metric"><div class="info-metric__label">Fat</div><div class="info-metric__value">${macroBase.fat_g ?? '-'} g</div></div>
                <div class="info-metric"><div class="info-metric__label">Sugar</div><div class="info-metric__value">${macroBase.sugar_g ?? '-'} g</div></div>
            </div>
        </div>
        <div style="margin-top:12px; color:#6b7280; font-size:13px;">
            ${result.saved?.product ? 'Saved product for future barcode lookups.' : ''}
            ${result.logged?.nutrition ? ' Added to daily Nutrition totals.' : ''}
            ${result.logged?.food_log ? ' Added to Food Log.' : ''}
        </div>
    `;
}

function renderFoodPhotoResult(result) {
    const box = document.getElementById('foodPhotoResult');
    if (!box) return;
    box.style.display = 'block';

    const insight = result.insight || {};
    const photoUrl = result.photo?.url;
    const conf = insight.confidence != null ? Math.round(insight.confidence * 100) : null;

    box.innerHTML = `
        <div class="foodscan-preview">
            ${photoUrl ? `<img src="${photoUrl}" alt="Food photo preview">` : ''}
            <div>
                <div class="info-panel__title">Estimated Nutrition</div>
                <div style="color:#6b7280; font-weight:700; margin-bottom:10px;">
                    ${insight.dish_name ? escapeHtml(insight.dish_name) : 'Unknown dish'}
                    ${conf != null ? ` • Confidence: ${conf}%` : ''}
                </div>
                <div class="info-grid">
                    <div class="info-metric">
                        <div class="info-metric__label">Calories</div>
                        <div class="info-metric__value">${insight.calories ?? '-'}</div>
                    </div>
                    <div class="info-metric">
                        <div class="info-metric__label">Protein</div>
                        <div class="info-metric__value">${insight.protein_g ?? '-'} g</div>
                    </div>
                    <div class="info-metric">
                        <div class="info-metric__label">Carbs</div>
                        <div class="info-metric__value">${insight.carbs_g ?? '-'} g</div>
                    </div>
                    <div class="info-metric">
                        <div class="info-metric__label">Fat</div>
                        <div class="info-metric__value">${insight.fat_g ?? '-'} g</div>
                    </div>
                </div>
                <div style="margin-top:12px; color:#6b7280; font-size:13px;">
                    ${result.logged?.nutrition ? 'Added to daily Nutrition totals.' : ''}
                    ${result.logged?.food_log ? ' Added to Food Log.' : ''}
                </div>
            </div>
        </div>
    `;
}

async function loadFoodPhotos() {
    const list = document.getElementById('foodPhotoList');
    if (!list) return;

    try {
        const response = await fetch('/api/food-photos');
        const data = await response.json();
        if (!response.ok) {
            list.innerHTML = `<div class="journal-item"><div class="journal-item__meta">Error loading photos: ${data.error || 'unknown'}</div></div>`;
            return;
        }
        if (!data.length) {
            list.innerHTML = `
                <div class="journal-item">
                    <div class="journal-item__title">No food photos yet</div>
                    <div class="journal-item__meta">Upload a photo above to log your meal.</div>
                </div>
            `;
            return;
        }
        list.innerHTML = data.slice(0, 12).map(p => {
            const title = p.dish_name || p.original_name || 'Food photo';
            const pills = [];
            if (p.calories != null) pills.push(`<span class="pill orange">${p.calories} cal</span>`);
            if (p.protein_g != null) pills.push(`<span class="pill green">P ${Math.round(p.protein_g)}g</span>`);
            if (p.carbs_g != null) pills.push(`<span class="pill blue">C ${Math.round(p.carbs_g)}g</span>`);
            if (p.fat_g != null) pills.push(`<span class="pill red">F ${Math.round(p.fat_g)}g</span>`);
            const thumb = p.url ? `<img src="${p.url}" alt="thumb" style="width:72px;height:72px;object-fit:cover;border-radius:10px;border:1px solid #e5e7eb;">` : '';
            return `
                <div class="journal-item">
                    <div class="journal-item__header">
                        <div style="display:flex; gap:12px;">
                            ${thumb}
                            <div>
                                <div class="journal-item__title">${escapeHtml(title)}</div>
                                <div class="journal-item__meta">${new Date(p.date).toLocaleDateString()}</div>
                            </div>
                        </div>
                        <button class="btn btn-secondary" style="padding:8px 12px;" onclick="viewFoodPhoto(${p.id})">
                            <i class="fas fa-eye"></i> View
                        </button>
                    </div>
                    ${pills.length ? `<div class="pill-row">${pills.join('')}</div>` : ''}
                </div>
            `;
        }).join('');
    } catch (err) {
        list.innerHTML = `<div class="journal-item"><div class="journal-item__meta">Network error loading photos.</div></div>`;
    }
}

async function viewFoodPhoto(id) {
    showLoading();
    try {
        const response = await fetch(`/api/food-photos/${id}`);
        const data = await response.json();
        if (!response.ok) {
            showNotification(data.error || 'Error loading photo', 'error');
            return;
        }
        const box = document.getElementById('foodPhotoResult');
        if (box) {
            renderFoodPhotoResult({ photo: { url: data.url }, insight: data.insight, logged: {} });
            box.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    } catch (err) {
        showNotification('Network error loading photo', 'error');
    } finally {
        hideLoading();
    }
}

window.viewFoodPhoto = viewFoodPhoto;

// Barcode scanning + product lookup
let barcodeStream = null;
let barcodeDetector = null;
let barcodeScanTimer = null;

async function startBarcodeScanner() {
    const wrap = document.getElementById('barcodeScannerWrap');
    const video = document.getElementById('barcodeVideo');
    const input = document.getElementById('barcodeInput');
    if (!wrap || !video || !input) return;

    // Feature detect BarcodeDetector
    if (!('BarcodeDetector' in window)) {
        showNotification('Barcode scanning not supported in this browser. Type the barcode manually.', 'error');
        return;
    }

    try {
        barcodeDetector = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'qr_code'] });
    } catch (e) {
        showNotification('Barcode scanning not available. Type the barcode manually.', 'error');
        return;
    }

    try {
        wrap.style.display = 'block';
        barcodeStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        video.srcObject = barcodeStream;

        // Poll detection
        if (barcodeScanTimer) clearInterval(barcodeScanTimer);
        barcodeScanTimer = setInterval(async () => {
            try {
                const barcodes = await barcodeDetector.detect(video);
                if (barcodes && barcodes.length) {
                    const code = barcodes[0].rawValue;
                    input.value = code;
                    stopBarcodeScanner();
                    await lookupBarcode();
                }
            } catch (err) {
                // ignore per-frame errors
            }
        }, 450);

        showNotification('Scanner started. Point at barcode.', 'info');
    } catch (e) {
        showNotification('Could not access camera. Check permissions and try again.', 'error');
        stopBarcodeScanner();
    }
}

function stopBarcodeScanner() {
    const wrap = document.getElementById('barcodeScannerWrap');
    const video = document.getElementById('barcodeVideo');
    if (barcodeScanTimer) {
        clearInterval(barcodeScanTimer);
        barcodeScanTimer = null;
    }
    if (barcodeStream) {
        barcodeStream.getTracks().forEach(t => t.stop());
        barcodeStream = null;
    }
    if (video) video.srcObject = null;
    if (wrap) wrap.style.display = 'none';
}

async function lookupBarcode() {
    const input = document.getElementById('barcodeInput');
    const box = document.getElementById('barcodeLookupResult');
    if (!input || !box) return;
    const gtin = (input.value || '').trim();
    if (!gtin) {
        showNotification('Enter a barcode/GTIN first', 'error');
        return;
    }

    showLoading();
    try {
        const response = await fetch(`/api/products/${encodeURIComponent(gtin)}`);
        const data = await response.json();
        box.style.display = 'block';
        if (!response.ok) {
            box.innerHTML = `
                <div class="info-panel__title">Not Found</div>
                <div style="color:#6b7280; font-weight:700;">No product in your local DB for GTIN ${escapeHtml(gtin)}.</div>
                <div style="margin-top:10px; color:#6b7280; font-size:13px;">
                    Next step: we can ingest UK products via licensed sources (e.g. Open Food Facts UK / GS1 / retailer feeds).
                </div>
            `;
            return;
        }

        const p = data.product || {};
        const n = data.nutrition || {};
        box.innerHTML = `
            <div class="foodscan-preview">
                ${p.image_url ? `<img src="${p.image_url}" alt="Product image">` : ''}
                <div>
                    <div class="info-panel__title">${escapeHtml(p.name || 'Product')}</div>
                    <div style="color:#6b7280; font-weight:700; margin-bottom:10px;">
                        ${escapeHtml(p.brand || '')} ${p.retailer ? '• ' + escapeHtml(p.retailer) : ''} • GTIN ${escapeHtml(p.gtin || gtin)}
                    </div>
                    <div class="info-grid">
                        <div class="info-metric">
                            <div class="info-metric__label">Calories / 100g</div>
                            <div class="info-metric__value">${n.calories_kcal_100g ?? '-'} kcal</div>
                        </div>
                        <div class="info-metric">
                            <div class="info-metric__label">Protein / 100g</div>
                            <div class="info-metric__value">${n.protein_g_100g ?? '-'} g</div>
                        </div>
                        <div class="info-metric">
                            <div class="info-metric__label">Carbs / 100g</div>
                            <div class="info-metric__value">${n.carbs_g_100g ?? '-'} g</div>
                        </div>
                        <div class="info-metric">
                            <div class="info-metric__label">Fat / 100g</div>
                            <div class="info-metric__value">${n.fat_g_100g ?? '-'} g</div>
                        </div>
                    </div>
                    ${p.ingredients ? `<div style="margin-top:12px; color:#374151;"><strong>Ingredients:</strong> ${escapeHtml(p.ingredients)}</div>` : ''}
                </div>
            </div>
        `;
    } catch (e) {
        showNotification('Error looking up product', 'error');
    } finally {
        hideLoading();
    }
}

// Fitness (Runs + Strength)
function normalizeExerciseNameClient(name) {
    return String(name || '').trim().replace(/\s+/g, ' ');
}

// Custom autocomplete dropdown (portal) for exercise picking
let exerciseAutocompletePortal = null;
let exerciseAutocompleteActive = null; // { input, items, activeIndex }
let exerciseAutocompleteDocListenerAttached = false;

function ensureExerciseAutocompletePortal() {
    if (exerciseAutocompletePortal) return exerciseAutocompletePortal;
    const el = document.createElement('div');
    el.id = 'exerciseAutocompletePortal';
    el.className = 'exercise-autocomplete-portal';
    el.style.display = 'none';
    document.body.appendChild(el);
    exerciseAutocompletePortal = el;

    if (!exerciseAutocompleteDocListenerAttached) {
        exerciseAutocompleteDocListenerAttached = true;
        document.addEventListener('click', (e) => {
            // close when clicking outside the active input/portal
            if (!exerciseAutocompleteActive) return;
            const portal = exerciseAutocompletePortal;
            const input = exerciseAutocompleteActive.input;
            if (portal && portal.contains(e.target)) return;
            if (input && input.contains && input.contains(e.target)) return;
            hideExerciseAutocomplete();
        }, true);

        window.addEventListener('resize', () => {
            if (exerciseAutocompleteActive) positionExerciseAutocompletePortal(exerciseAutocompleteActive.input);
        });
        window.addEventListener('scroll', () => {
            if (exerciseAutocompleteActive) positionExerciseAutocompletePortal(exerciseAutocompleteActive.input);
        }, true);
    }

    return el;
}

function positionExerciseAutocompletePortal(inputEl) {
    const portal = ensureExerciseAutocompletePortal();
    const r = inputEl.getBoundingClientRect();
    portal.style.position = 'fixed';
    portal.style.left = `${Math.max(8, r.left)}px`;
    portal.style.top = `${Math.min(window.innerHeight - 8, r.bottom + 6)}px`;
    portal.style.width = `${Math.max(220, r.width)}px`;
}

function hideExerciseAutocomplete() {
    if (!exerciseAutocompletePortal) return;
    exerciseAutocompletePortal.style.display = 'none';
    exerciseAutocompletePortal.innerHTML = '';
    exerciseAutocompleteActive = null;
}

function buildExerciseSuggestionItems(query) {
    const q = String(query || '').trim().toLowerCase();
    const items = [];

    const names = (exerciseLibrary || []).map(e => e?.name).filter(Boolean);
    const exact = q && names.some(n => n.toLowerCase() === q);

    if (q && !exact) {
        items.push({
            kind: 'new',
            name: query,
            label: `Use “${query}” (new)`
        });
    }

    const matches = (exerciseLibrary || [])
        .filter(e => (e?.name || '').toLowerCase().includes(q))
        .slice(0, 10);

    matches.forEach(e => {
        const metaParts = [];
        if (e.muscle_group) metaParts.push(e.muscle_group);
        if (e.equipment) metaParts.push(e.equipment);
        items.push({
            kind: 'existing',
            name: e.name,
            meta: metaParts.join(' • ')
        });
    });

    // If empty query, show first few exercises
    if (!q) {
        (exerciseLibrary || []).slice(0, 10).forEach(e => {
            if (!e?.name) return;
            const metaParts = [];
            if (e.muscle_group) metaParts.push(e.muscle_group);
            if (e.equipment) metaParts.push(e.equipment);
            items.push({
                kind: 'existing',
                name: e.name,
                meta: metaParts.join(' • ')
            });
        });
    }

    // De-dupe by name while preserving order (and keep "new" if present)
    const seen = new Set();
    return items.filter(it => {
        const key = `${it.kind}:${String(it.name).toLowerCase()}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function highlightMatchHtml(text, query) {
    const t = String(text || '');
    const q = String(query || '').trim();
    if (!q) return escapeHtml(t);
    const idx = t.toLowerCase().indexOf(q.toLowerCase());
    if (idx === -1) return escapeHtml(t);
    const before = t.slice(0, idx);
    const match = t.slice(idx, idx + q.length);
    const after = t.slice(idx + q.length);
    return `${escapeHtml(before)}<mark class="exercise-autocomplete-mark">${escapeHtml(match)}</mark>${escapeHtml(after)}`;
}

function renderExerciseAutocomplete(inputEl) {
    const portal = ensureExerciseAutocompletePortal();
    const query = inputEl.value || '';
    const items = buildExerciseSuggestionItems(query);
    if (!items.length) {
        hideExerciseAutocomplete();
        return;
    }

    positionExerciseAutocompletePortal(inputEl);
    portal.style.display = 'block';

    const activeIndex = 0;
    exerciseAutocompleteActive = { input: inputEl, items, activeIndex };

    portal.innerHTML = `
        <div class="exercise-autocomplete-menu" role="listbox">
            ${items.map((it, idx) => `
                <div class="exercise-autocomplete-item ${idx === activeIndex ? 'active' : ''}" data-idx="${idx}">
                    <div class="exercise-autocomplete-title">${it.kind === 'new' ? escapeHtml(it.label) : highlightMatchHtml(it.name, query)
        }</div>
                    ${it.meta ? `<div class="exercise-autocomplete-meta">${escapeHtml(it.meta)}</div>` : ''}
                </div>
            `).join('')}
        </div>
    `;

    portal.querySelectorAll('.exercise-autocomplete-item').forEach(el => {
        el.addEventListener('mousedown', (e) => {
            // mousedown so we can select before input loses focus
            e.preventDefault();
            const idx = Number(el.dataset.idx);
            pickExerciseAutocompleteIndex(idx);
        });
    });
}

function highlightExerciseAutocompleteIndex(nextIndex) {
    if (!exerciseAutocompleteActive || !exerciseAutocompletePortal) return;
    const max = exerciseAutocompleteActive.items.length;
    const idx = Math.max(0, Math.min(max - 1, nextIndex));
    exerciseAutocompleteActive.activeIndex = idx;
    exerciseAutocompletePortal.querySelectorAll('.exercise-autocomplete-item').forEach((el, i) => {
        el.classList.toggle('active', i === idx);
    });
    const activeEl = exerciseAutocompletePortal.querySelector(`.exercise-autocomplete-item[data-idx="${idx}"]`);
    if (activeEl && activeEl.scrollIntoView) activeEl.scrollIntoView({ block: 'nearest' });
}

function pickExerciseAutocompleteIndex(idx) {
    if (!exerciseAutocompleteActive) return;
    const it = exerciseAutocompleteActive.items[idx];
    if (!it) return;
    exerciseAutocompleteActive.input.value = normalizeExerciseNameClient(it.name);
    hideExerciseAutocomplete();
}

function wireExerciseAutocompleteToInput(inputEl) {
    if (!inputEl || inputEl.dataset.autocompleteWired === 'true') return;
    inputEl.dataset.autocompleteWired = 'true';
    inputEl.setAttribute('autocomplete', 'off');
    inputEl.removeAttribute('list'); // disable native datalist UI

    inputEl.addEventListener('focus', () => {
        renderExerciseAutocomplete(inputEl);
    });
    inputEl.addEventListener('input', () => {
        renderExerciseAutocomplete(inputEl);
    });
    inputEl.addEventListener('keydown', (e) => {
        if (!exerciseAutocompleteActive || exerciseAutocompleteActive.input !== inputEl) return;
        if (e.key === 'Escape') {
            e.preventDefault();
            hideExerciseAutocomplete();
            return;
        }
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            highlightExerciseAutocompleteIndex((exerciseAutocompleteActive.activeIndex || 0) + 1);
            return;
        }
        if (e.key === 'ArrowUp') {
            e.preventDefault();
            highlightExerciseAutocompleteIndex((exerciseAutocompleteActive.activeIndex || 0) - 1);
            return;
        }
        if (e.key === 'Enter') {
            // If menu open, pick highlighted item
            if (exerciseAutocompletePortal && exerciseAutocompletePortal.style.display !== 'none') {
                e.preventDefault();
                pickExerciseAutocompleteIndex(exerciseAutocompleteActive.activeIndex || 0);
            }
        }
    });
}

function renderExerciseDatalist() {
    const dl = document.getElementById('exerciseDatalist');
    if (!dl) return;
    dl.innerHTML = (exerciseLibrary || [])
        .map(e => `<option value="${escapeHtml(e.name)}"></option>`)
        .join('');
}

function renderExerciseLibraryList() {
    const box = document.getElementById('exerciseLibraryList');
    if (!box) return;
    if (!exerciseLibrary.length) {
        box.innerHTML = `<div class="journal-item"><div class="journal-item__meta">No exercises yet. Add your first one above.</div></div>`;
        return;
    }
    const shown = exerciseLibrary.slice(0, 40);
    box.innerHTML = shown.map(e => {
        const meta = [
            e.muscle_group ? escapeHtml(e.muscle_group) : null,
            e.equipment ? escapeHtml(e.equipment) : null,
            (e.tags && e.tags.length) ? escapeHtml(e.tags.join(', ')) : null
        ].filter(Boolean).join(' • ');
        return `
            <div class="journal-item">
                <div class="journal-item__header">
                    <div>
                        <div class="journal-item__title">${escapeHtml(e.name)}</div>
                        ${meta ? `<div class="journal-item__meta">${meta}</div>` : `<div class="journal-item__meta"> </div>`}
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

async function refreshExerciseLibrary() {
    try {
        const resp = await fetch('/api/exercises?limit=500');
        const data = await resp.json();
        if (!resp.ok) return;
        exerciseLibrary = Array.isArray(data) ? data : [];
        renderExerciseDatalist();
        renderExerciseLibraryList();
    } catch (e) {
        // ignore
    }
}

async function upsertExerciseClient(name, meta = {}) {
    const n = normalizeExerciseNameClient(name);
    if (!n) return;
    try {
        await fetch('/api/exercises', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: n,
                muscle_group: meta.muscle_group || null,
                equipment: meta.equipment || null,
                tags: meta.tags || null
            })
        });
    } catch (e) {
        // ignore
    }
}

async function handleExerciseAdd(e) {
    e.preventDefault();
    const name = normalizeExerciseNameClient(document.getElementById('exerciseName')?.value);
    const muscle_group = document.getElementById('exerciseMuscleGroup')?.value?.trim() || '';
    const equipment = document.getElementById('exerciseEquipment')?.value?.trim() || '';
    const tags = document.getElementById('exerciseTags')?.value?.trim() || '';
    if (!name) {
        showNotification('Exercise name is required', 'error');
        return;
    }
    showLoading();
    try {
        const resp = await fetch('/api/exercises', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, muscle_group: muscle_group || null, equipment: equipment || null, tags: tags || null })
        });
        const data = await resp.json();
        if (!resp.ok) {
            showNotification(data.error || 'Error saving exercise', 'error');
            return;
        }
        showNotification('Exercise added', 'success');
        e.target.reset();
        await refreshExerciseLibrary();
    } catch (err) {
        showNotification('Network error saving exercise', 'error');
    } finally {
        hideLoading();
    }
}

function initStrengthSetsTable() {
    const tbody = document.getElementById('setsTbody');
    if (!tbody) return;
    if (tbody.children.length === 0) {
        addSetRow();
        addSetRow();
        addSetRow();
    }
    // Ensure chart input uses the same autocomplete
    wireExerciseAutocompleteToInput(document.getElementById('exerciseSelect'));
}

function addSetRow(prefill = {}) {
    const tbody = document.getElementById('setsTbody');
    if (!tbody) return;
    const tr = document.createElement('tr');
    tr.innerHTML = `
        <td><input type="text" class="set-exercise" placeholder="e.g., Bench Press" value="${escapeHtml(prefill.exercise || '')}" style="width:100%; padding:10px 12px; border:1px solid #e5e7eb; border-radius:10px;"></td>
        <td class="num"><input type="number" class="set-reps" min="0" step="1" value="${prefill.reps ?? ''}" style="width:100px; padding:10px 12px; border:1px solid #e5e7eb; border-radius:10px; text-align:right;"></td>
        <td class="num"><input type="number" class="set-weight" min="0" step="0.5" value="${prefill.weight_kg ?? ''}" style="width:120px; padding:10px 12px; border:1px solid #e5e7eb; border-radius:10px; text-align:right;"></td>
        <td class="num"><input type="number" class="set-rpe" min="0" max="10" step="0.5" value="${prefill.rpe ?? ''}" style="width:90px; padding:10px 12px; border:1px solid #e5e7eb; border-radius:10px; text-align:right;"></td>
        <td class="num"><button type="button" class="btn btn-secondary remove-set" style="padding:8px 10px;"><i class="fas fa-trash"></i></button></td>
    `;
    tr.querySelector('.remove-set').addEventListener('click', () => {
        tr.remove();
    });
    wireExerciseAutocompleteToInput(tr.querySelector('.set-exercise'));
    tbody.appendChild(tr);
}

async function handleRunSubmit(e) {
    e.preventDefault();
    showLoading();
    try {
        const date = document.getElementById('runDate').value;
        const distance_km = document.getElementById('runDistance').value;
        const duration_minutes = document.getElementById('runDuration').value;
        const calories = document.getElementById('runCalories').value;
        const notes = document.getElementById('runNotes').value;

        const response = await fetch('/api/workouts/session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                date,
                type: 'run',
                name: 'Run',
                notes,
                distance_km,
                duration_minutes,
                calories
            })
        });
        const result = await response.json();
        if (!response.ok) {
            showNotification(result.error || 'Error saving run', 'error');
            return;
        }
        showNotification('Run saved', 'success');
        e.target.reset();
        setDefaultDates();
        await refreshFitnessCharts();
        await loadRecentWorkouts();
        if (document.getElementById('dashboard').classList.contains('active')) {
            loadDashboardData();
        }
    } catch (err) {
        showNotification('Network error saving run', 'error');
    } finally {
        hideLoading();
    }
}

async function handleStrengthSubmit(e) {
    e.preventDefault();
    showLoading();
    try {
        const date = document.getElementById('strengthDate').value;
        const name = document.getElementById('strengthName').value;
        const duration_minutes = document.getElementById('strengthDuration').value;
        const notes = document.getElementById('strengthNotes').value;

        const resp1 = await fetch('/api/workouts/session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                date,
                type: 'strength',
                name: name || 'Strength',
                notes,
                duration_minutes: duration_minutes || null
            })
        });
        const created = await resp1.json();
        if (!resp1.ok) {
            showNotification(created.error || 'Error saving strength workout', 'error');
            return;
        }

        const sessionId = created.session.id;
        const rows = Array.from(document.querySelectorAll('#setsTbody tr'));
        const sets = rows.map((tr, idx) => ({
            set_index: idx + 1,
            exercise: normalizeExerciseNameClient(tr.querySelector('.set-exercise')?.value || ''),
            reps: tr.querySelector('.set-reps')?.value || '',
            weight_kg: tr.querySelector('.set-weight')?.value || '',
            rpe: tr.querySelector('.set-rpe')?.value || ''
        })).filter(s => (s.exercise || '').trim().length > 0);

        // Auto-save any new exercise names into the shared library
        const uniqueExercises = [...new Set(sets.map(s => s.exercise).filter(Boolean))];
        await Promise.all(uniqueExercises.map(ex => upsertExerciseClient(ex)));
        refreshExerciseLibrary().catch(() => { });

        if (sets.length) {
            const resp2 = await fetch(`/api/workouts/session/${sessionId}/sets`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sets })
            });
            const added = await resp2.json();
            if (!resp2.ok) {
                showNotification(added.error || 'Saved session but failed to add sets', 'error');
            }
        }

        showNotification('Strength workout saved', 'success');
        e.target.reset();
        // reset table
        document.getElementById('setsTbody').innerHTML = '';
        initStrengthSetsTable();
        setDefaultDates();
        await refreshFitnessCharts();
        await loadRecentWorkouts();
    } catch (err) {
        showNotification('Network error saving strength workout', 'error');
    } finally {
        hideLoading();
    }
}

async function refreshFitnessCharts() {
    await Promise.all([renderRunCharts(), renderStrengthCharts(), loadRecentWorkouts()]);
}

async function renderRunCharts() {
    try {
        const response = await fetch('/api/workouts/progress/runs');
        const runs = await response.json();
        if (!response.ok) return;

        const labels = runs.map(r => new Date(r.date).toLocaleDateString());
        const distances = runs.map(r => r.distance_km ?? null);
        const pace = runs.map(r => r.pace_min_per_km ?? null);

        const ctxD = document.getElementById('runDistanceChart')?.getContext('2d');
        const ctxP = document.getElementById('runPaceChart')?.getContext('2d');
        if (!ctxD || !ctxP) return;

        if (charts.runDistanceChart) charts.runDistanceChart.destroy();
        if (charts.runPaceChart) charts.runPaceChart.destroy();

        charts.runDistanceChart = new Chart(ctxD, {
            type: 'line',
            data: {
                labels,
                datasets: [{
                    label: 'Distance (km)',
                    data: distances,
                    borderColor: '#667eea',
                    backgroundColor: 'rgba(102, 126, 234, 0.12)',
                    borderWidth: 3,
                    fill: true,
                    tension: 0.35
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: {
                    y: { beginAtZero: true },
                    x: { grid: { display: false } }
                }
            }
        });

        charts.runPaceChart = new Chart(ctxP, {
            type: 'line',
            data: {
                labels,
                datasets: [{
                    label: 'Pace (min/km)',
                    data: pace,
                    borderColor: '#22c55e',
                    backgroundColor: 'rgba(34, 197, 94, 0.12)',
                    borderWidth: 3,
                    fill: true,
                    tension: 0.35
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: {
                    y: { beginAtZero: false },
                    x: { grid: { display: false } }
                }
            }
        });
    } catch (e) {
        // ignore
    }
}

async function renderStrengthCharts() {
    try {
        const exercise = document.getElementById('exerciseSelect')?.value?.trim() || '';
        const url = exercise ? `/api/workouts/progress/strength?exercise=${encodeURIComponent(exercise)}` : '/api/workouts/progress/strength';
        const response = await fetch(url);
        const rows = await response.json();
        if (!response.ok) return;

        const ctx1 = document.getElementById('strength1rmChart')?.getContext('2d');
        const ctxV = document.getElementById('strengthVolumeChart')?.getContext('2d');
        if (!ctx1 || !ctxV) return;

        // If multiple exercises returned (when no filter), pick top 1 by frequency for chart clarity
        let data = rows;
        if (!exercise) {
            const counts = {};
            rows.forEach(r => { counts[r.exercise] = (counts[r.exercise] || 0) + 1; });
            const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
            data = top ? rows.filter(r => r.exercise === top) : [];
        }

        const labels = data.map(r => new Date(r.date).toLocaleDateString());
        const est1rm = data.map(r => r.est_1rm_kg != null ? Number(r.est_1rm_kg.toFixed ? r.est_1rm_kg.toFixed(1) : r.est_1rm_kg) : null);
        const volume = data.map(r => r.volume_kg != null ? Number(r.volume_kg.toFixed ? r.volume_kg.toFixed(0) : r.volume_kg) : null);

        if (charts.strength1rmChart) charts.strength1rmChart.destroy();
        if (charts.strengthVolumeChart) charts.strengthVolumeChart.destroy();

        charts.strength1rmChart = new Chart(ctx1, {
            type: 'line',
            data: {
                labels, datasets: [{
                    label: 'Estimated 1RM (kg)',
                    data: est1rm,
                    borderColor: '#f59e0b',
                    backgroundColor: 'rgba(245, 158, 11, 0.12)',
                    borderWidth: 3,
                    fill: true,
                    tension: 0.35
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: { x: { grid: { display: false } } }
            }
        });

        charts.strengthVolumeChart = new Chart(ctxV, {
            type: 'bar',
            data: {
                labels, datasets: [{
                    label: 'Volume (kg)',
                    data: volume,
                    backgroundColor: 'rgba(99, 102, 241, 0.75)',
                    borderColor: '#6366f1',
                    borderWidth: 1
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: { x: { grid: { display: false } }, y: { beginAtZero: true } }
            }
        });
    } catch (e) {
        // ignore
    }
}

async function loadRecentWorkouts() {
    const box = document.getElementById('fitnessRecent');
    if (!box) return;
    try {
        const response = await fetch('/api/workouts?limit=40');
        const sessions = await response.json();
        if (!response.ok) {
            box.innerHTML = `<div class="journal-item"><div class="journal-item__meta">Error loading workouts</div></div>`;
            return;
        }
        if (!sessions.length) {
            box.innerHTML = `<div class="journal-item"><div class="journal-item__title">No workouts yet</div><div class="journal-item__meta">Log a run or strength workout above.</div></div>`;
            return;
        }
        box.innerHTML = sessions.slice(0, 12).map(s => {
            const title = s.name || (s.type === 'run' ? 'Run' : 'Strength');
            const pills = [];
            if (s.type === 'run') {
                if (s.distance_km != null) pills.push(`<span class="pill blue">${Number(s.distance_km).toFixed(2)} km</span>`);
                if (s.pace_min_per_km != null) pills.push(`<span class="pill green">${Number(s.pace_min_per_km).toFixed(2)} min/km</span>`);
                if (s.duration_minutes != null) pills.push(`<span class="pill orange">${Number(s.duration_minutes).toFixed(0)} min</span>`);
            } else if (s.type === 'strength') {
                if (s.duration_minutes != null) pills.push(`<span class="pill orange">${Number(s.duration_minutes).toFixed(0)} min</span>`);
            }
            return `
                <div class="journal-item">
                    <div class="journal-item__header">
                        <div>
                            <div class="journal-item__title">${escapeHtml(title)}</div>
                            <div class="journal-item__meta">${new Date(s.date).toLocaleDateString()} • ${s.type}</div>
                        </div>
                        <div style="display:flex; gap:8px;">
                            <button class="btn btn-secondary" style="padding:8px 12px;" onclick="viewWorkout(${s.id})">
                                <i class="fas fa-eye"></i> View
                            </button>
                            <button class="btn btn-secondary" style="padding:8px 12px; color:#ef4444;" onclick="deleteWorkout(${s.id})">
                                <i class="fas fa-trash"></i>
                            </button>
                        </div>
                    </div>
                    ${pills.length ? `<div class="pill-row">${pills.join('')}</div>` : ''}
                    ${s.notes ? `<div style="margin-top:10px; color:#374151;">${escapeHtml(s.notes)}</div>` : ''}
                </div>
            `;
        }).join('');
    } catch (e) {
        box.innerHTML = `<div class="journal-item"><div class="journal-item__meta">Network error loading workouts</div></div>`;
    }
}

async function deleteWorkout(id) {
    if (!confirm('Are you sure you want to delete this workout?')) return;
    showLoading();
    try {
        const resp = await fetch(`/api/workouts/${id}`, { method: 'DELETE' });
        if (!resp.ok) {
            const data = await resp.json();
            showNotification(data.error || 'Failed to delete workout', 'error');
            return;
        }
        showNotification('Workout deleted', 'success');
        await refreshFitnessCharts();
    } catch (e) {
        showNotification('Network error', 'error');
    } finally {
        hideLoading();
    }
}
window.deleteWorkout = deleteWorkout;

// Modal Helpers
function showModal(title, content) {
    document.getElementById('appModalTitle').textContent = title;
    document.getElementById('appModalBody').innerHTML = content;
    document.getElementById('appModal').classList.add('open');
}

function closeModal() {
    document.getElementById('appModal').classList.remove('open');
}
window.closeModal = closeModal;

// Close on Escape key
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
});

async function viewWorkout(id) {
    showLoading();
    try {
        const response = await fetch(`/api/workouts/${id}`);
        const data = await response.json();
        if (!response.ok) {
            showNotification(data.error || 'Error loading workout', 'error');
            return;
        }

        const s = data.session;
        let html = '';

        // Common details
        html += `<div class="info-grid">`;
        html += `<div class="info-item"><label>Date</label><div>${new Date(s.date).toLocaleDateString()}</div></div>`;
        html += `<div class="info-item"><label>Type</label><div>${s.type.toUpperCase()}</div></div>`;

        if (s.duration_minutes) {
            html += `<div class="info-item"><label>Duration</label><div>${Number(s.duration_minutes).toFixed(0)} min</div></div>`;
        }

        if (s.type === 'run') {
            if (s.distance_km) html += `<div class="info-item"><label>Distance</label><div>${Number(s.distance_km).toFixed(2)} km</div></div>`;
            if (s.pace_min_per_km) html += `<div class="info-item"><label>Pace</label><div>${Number(s.pace_min_per_km).toFixed(2)} /km</div></div>`;
            if (s.calories) html += `<div class="info-item"><label>Calories</label><div>${s.calories}</div></div>`;
        }
        html += `</div>`; // end grid

        if (s.notes) {
            html += `<div style="margin-bottom:20px; padding:12px; background:#f3f4f6; border-radius:8px;">
                <label style="font-size:0.75rem; color:#6b7280; font-weight:700; display:block; margin-bottom:4px;">NOTES</label>
                <div style="font-style:italic; color:#374151;">${escapeHtml(s.notes)}</div>
            </div>`;
        }

        // Strength Sets
        if (s.type === 'strength' && data.sets && data.sets.length) {
            html += `<h4 style="margin:20px 0 10px 0; color:#4b5563;">Sets</h4>`;
            html += `<div style="overflow-x:auto;"><table class="table-compact">
                <thead>
                    <tr>
                        <th style="width:40%">Exercise</th>
                        <th style="text-align:right">Reps</th>
                        <th style="text-align:right">Weight (kg)</th>
                        <th style="text-align:right">RPE</th>
                    </tr>
                </thead>
                <tbody>`;

            data.sets.forEach(set => {
                html += `<tr>
                    <td>${escapeHtml(set.exercise)}</td>
                    <td style="text-align:right">${set.reps || '-'}</td>
                    <td style="text-align:right">${set.weight_kg || '-'}</td>
                    <td style="text-align:right">${set.rpe || '-'}</td>
                </tr>`;
            });

            html += `</tbody></table></div>`;
        }

        showModal(s.name || (s.type === 'run' ? 'Run Details' : 'Strength Workout'), html);

    } finally {
        hideLoading();
    }
}

window.viewWorkout = viewWorkout;

// Body composition (Hume/BodyPod)
async function handleBodyCompImport(e) {
    e.preventDefault();
    const fileInput = document.getElementById('bodyCompFile');
    const file = fileInput.files[0];
    const source = document.getElementById('bodyCompSource').value;
    const resultBox = document.getElementById('bodyCompImportResult');
    if (!file) {
        showNotification('Please choose a CSV/Excel file', 'error');
        return;
    }
    showLoading();
    try {
        const fd = new FormData();
        fd.append('file', file);
        fd.append('source', source);
        const resp = await fetch('/api/bodycomp/import', { method: 'POST', body: fd });
        const data = await resp.json();
        if (!resp.ok) {
            showNotification(data.error || 'Import failed', 'error');
            if (resultBox) {
                resultBox.style.display = 'block';
                resultBox.innerHTML = `<div class="info-panel__title">Import Failed</div><div style="color:#6b7280;font-weight:700;">${escapeHtml(data.error || 'Unknown error')}</div>`;
            }
            return;
        }
        showNotification(`Imported ${data.inserted} measurements`, 'success');
        if (resultBox) {
            resultBox.style.display = 'block';
            resultBox.innerHTML = `
                <div class="info-panel__title">Import Complete</div>
                <div style="color:#374151; font-weight:800;">Inserted/updated: ${data.inserted}</div>
                <div style="color:#6b7280; font-weight:700; margin-top:6px;">Rows parsed: ${data.rows_parsed} • Source: ${escapeHtml(data.source)}</div>
            `;
        }
        e.target.reset();
        await refreshBodyComp();
    } catch (err) {
        showNotification('Network error importing file', 'error');
    } finally {
        hideLoading();
    }
}

async function refreshBodyComp() {
    await Promise.all([renderBodyCompCharts(), loadBodyCompList()]);
}

async function renderBodyCompCharts() {
    try {
        const resp = await fetch('/api/bodycomp/progress');
        const rows = await resp.json();
        if (!resp.ok) return;
        const labels = rows.map(r => new Date(r.date).toLocaleDateString());

        const weight = rows.map(r => r.weight_kg ?? null);
        const bf = rows.map(r => r.body_fat_pct ?? null);
        const bmi = rows.map(r => r.bmi ?? null);
        const hyd = rows.map(r => r.hydration_pct ?? null);

        const wctx = document.getElementById('weightChart')?.getContext('2d');
        const bfctx = document.getElementById('bodyFatChart')?.getContext('2d');
        const bmictx = document.getElementById('bmiChart')?.getContext('2d');
        const hctx = document.getElementById('hydrationChart')?.getContext('2d');
        if (!wctx || !bfctx || !bmictx || !hctx) return;

        // destroy if exists
        if (charts.weightChart) charts.weightChart.destroy();
        if (charts.bodyFatChart) charts.bodyFatChart.destroy();
        if (charts.bmiChart) charts.bmiChart.destroy();
        if (charts.hydrationChart) charts.hydrationChart.destroy();

        const mkLine = (ctx, data, color) => new Chart(ctx, {
            type: 'line',
            data: {
                labels, datasets: [{
                    data,
                    borderColor: color,
                    backgroundColor: color.replace('1)', '0.12)'),
                    borderWidth: 3,
                    fill: true,
                    tension: 0.35
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: { x: { grid: { display: false } } }
            }
        });

        charts.weightChart = mkLine(wctx, weight, 'rgba(99, 102, 241, 1)');
        charts.bodyFatChart = mkLine(bfctx, bf, 'rgba(245, 158, 11, 1)');
        charts.bmiChart = mkLine(bmictx, bmi, 'rgba(34, 197, 94, 1)');
        charts.hydrationChart = mkLine(hctx, hyd, 'rgba(59, 130, 246, 1)');
    } catch (e) {
        // ignore
    }
}

async function loadBodyCompList() {
    const box = document.getElementById('bodyCompList');
    if (!box) return;
    try {
        const resp = await fetch('/api/bodycomp?limit=60');
        const rows = await resp.json();
        if (!resp.ok) {
            box.innerHTML = `<div class="journal-item"><div class="journal-item__meta">Error loading measurements</div></div>`;
            return;
        }
        if (!rows.length) {
            box.innerHTML = `<div class="journal-item"><div class="journal-item__title">No measurements yet</div><div class="journal-item__meta">Import a CSV above to get started.</div></div>`;
            return;
        }
        box.innerHTML = rows.slice(0, 12).map(r => {
            const pills = [];
            if (r.weight_kg != null) pills.push(`<span class="pill blue">${Number(r.weight_kg).toFixed(1)} kg</span>`);
            if (r.body_fat_pct != null) pills.push(`<span class="pill orange">${Number(r.body_fat_pct).toFixed(1)}% fat</span>`);
            if (r.bmi != null) pills.push(`<span class="pill green">BMI ${Number(r.bmi).toFixed(1)}</span>`);
            if (r.hydration_pct != null) pills.push(`<span class="pill">Hyd ${Number(r.hydration_pct).toFixed(1)}%</span>`);
            return `
                <div class="journal-item">
                    <div class="journal-item__header">
                        <div>
                            <div class="journal-item__title">${new Date(r.date).toLocaleDateString()}</div>
                            <div class="journal-item__meta">${escapeHtml(r.source || 'import')}</div>
                        </div>
                    </div>
                    ${pills.length ? `<div class="pill-row">${pills.join('')}</div>` : ''}
                </div>
            `;
        }).join('');
    } catch (e) {
        box.innerHTML = `<div class="journal-item"><div class="journal-item__meta">Network error loading measurements</div></div>`;
    }
}

// Collapsible Cards Functionality
function toggleCard(cardId) {
    const cardContent = document.getElementById(cardId);
    const toggle = document.getElementById(cardId.replace('Card', 'Toggle'));

    if (cardContent.classList.contains('expanded')) {
        cardContent.classList.remove('expanded');
        toggle.textContent = '▶';
    } else {
        cardContent.classList.add('expanded');
        toggle.textContent = '▼';
    }
}

function expandAllCards() {
    document.querySelectorAll('.card-content').forEach(card => {
        card.classList.add('expanded');
    });
    document.querySelectorAll('.card-toggle').forEach(toggle => {
        toggle.textContent = '▼';
    });
}

function collapseAllCards() {
    document.querySelectorAll('.card-content').forEach(card => {
        card.classList.remove('expanded');
    });
    document.querySelectorAll('.card-toggle').forEach(toggle => {
        toggle.textContent = '▶';
    });
}

// Range Slider Setup
function setupRangeSliders() {
    document.querySelectorAll('input[type="range"]').forEach(slider => {
        const valueDisplay = slider.parentNode.querySelector('.range-value');

        slider.addEventListener('input', function () {
            valueDisplay.textContent = this.value;
        });
    });
}

// Set Default Dates
function setDefaultDates() {
    const today = new Date().toISOString().split('T')[0];
    document.querySelectorAll('input[type="date"]').forEach(input => {
        if (!input.value) {
            input.value = today;
        }
    });

    // Default time for food log to "now" (optional)
    const foodTime = document.getElementById('foodTime');
    if (foodTime && !foodTime.value) {
        const d = new Date();
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        foodTime.value = `${hh}:${mm}`;
    }
}

// Form Submission Handlers
async function handleSleepSubmit(e) {
    e.preventDefault();
    showLoading();

    const formData = new FormData(e.target);
    const data = Object.fromEntries(formData);

    try {
        const response = await fetch('/api/sleep', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(data)
        });

        const result = await response.json();

        if (response.ok) {
            showNotification('Sleep data saved successfully!', 'success');
            e.target.reset();
            setDefaultDates();
            loadDashboardData();
        } else {
            showNotification(result.error || 'Error saving sleep data', 'error');
        }
    } catch (error) {
        showNotification('Network error. Please try again.', 'error');
    } finally {
        hideLoading();
    }
}

async function handleActivitySubmit(e) {
    e.preventDefault();
    showLoading();

    const formData = new FormData(e.target);
    const data = Object.fromEntries(formData);

    try {
        const response = await fetch('/api/activity', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(data)
        });

        const result = await response.json();

        if (response.ok) {
            showNotification('Activity data saved successfully!', 'success');
            e.target.reset();
            setDefaultDates();
            loadDashboardData();
        } else {
            showNotification(result.error || 'Error saving activity data', 'error');
        }
    } catch (error) {
        showNotification('Network error. Please try again.', 'error');
    } finally {
        hideLoading();
    }
}

async function handleNutritionSubmit(e) {
    e.preventDefault();
    showLoading();

    const formData = new FormData(e.target);
    const data = Object.fromEntries(formData);

    try {
        const response = await fetch('/api/nutrition', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(data)
        });

        const result = await response.json();

        if (response.ok) {
            showNotification('Nutrition data saved successfully!', 'success');
            e.target.reset();
            setDefaultDates();
            loadDashboardData();
        } else {
            showNotification(result.error || 'Error saving nutrition data', 'error');
        }
    } catch (error) {
        showNotification('Network error. Please try again.', 'error');
    } finally {
        hideLoading();
    }
}

async function handleFoodLogSubmit(e) {
    e.preventDefault();
    showLoading();

    const formData = new FormData(e.target);
    const data = Object.fromEntries(formData);
    // If user filled quantity but not serving size, auto-fill serving_size
    if ((!data.serving_size || String(data.serving_size).trim() === '') && data.quantity) {
        const u = data.quantity_unit || '';
        data.serving_size = `${data.quantity} ${u}`.trim();
    }

    try {
        const response = await fetch('/api/food-log', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(data)
        });

        const result = await response.json();

        if (response.ok) {
            showNotification('Food log entry saved successfully!', 'success');
            e.target.reset();
            setDefaultDates();
            const resultBox = document.getElementById('foodAiEstimateResult');
            if (resultBox) resultBox.style.display = 'none';
        } else {
            showNotification(result.error || 'Error saving food log entry', 'error');
        }
    } catch (error) {
        showNotification('Network error. Please try again.', 'error');
    } finally {
        hideLoading();
    }
}

async function handleMoodSubmit(e) {
    e.preventDefault();
    showLoading();

    const formData = new FormData(e.target);
    const data = Object.fromEntries(formData);

    try {
        const response = await fetch('/api/mood', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(data)
        });

        const result = await response.json();

        if (response.ok) {
            showNotification('Mood data saved successfully!', 'success');
            e.target.reset();
            setDefaultDates();
            setupRangeSliders();
            loadDashboardData();
        } else {
            showNotification(result.error || 'Error saving mood data', 'error');
        }
    } catch (error) {
        showNotification('Network error. Please try again.', 'error');
    } finally {
        hideLoading();
    }
}

async function handleSupplementsSubmit(e) {
    e.preventDefault();
    showLoading();

    const formData = new FormData(e.target);
    const data = Object.fromEntries(formData);

    try {
        const response = await fetch('/api/supplements', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(data)
        });

        const result = await response.json();

        if (response.ok) {
            showNotification('Supplement added successfully!', 'success');
            e.target.reset();
            setDefaultDates();
            // New UI uses regimen list; refresh it if present
            loadSupplementsDay().catch(() => { });
        } else {
            showNotification(result.error || 'Error adding supplement', 'error');
        }
    } catch (error) {
        showNotification('Network error. Please try again.', 'error');
    } finally {
        hideLoading();
    }
}

async function loadSupplementsDay() {
    const dateEl = document.getElementById('supplementsDayDate');
    const box = document.getElementById('supplementsDayList');
    if (!dateEl || !box) return;
    if (!dateEl.value) dateEl.value = new Date().toISOString().split('T')[0];
    const date = dateEl.value;

    showLoading();
    try {
        const resp = await fetch(`/api/supplements/day?date=${encodeURIComponent(date)}`);
        const items = await resp.json().catch(() => []);
        if (!resp.ok) {
            box.innerHTML = `<div class="journal-item"><div class="journal-item__meta" style="color:#b91c1c;font-weight:900;">${escapeHtml(items.error || 'Failed')}</div></div>`;
            return;
        }
        if (!items.length) {
            box.innerHTML = `<div class="journal-item"><div class="journal-item__title">No regimens yet</div><div class="journal-item__meta">Add a recurring supplement below.</div></div>`;
            return;
        }
        box.innerHTML = items.map(it => {
            const r = it.regimen || {};
            const taken = !!it.taken;
            const time = it.time_text || (r.default_times?.[0] || '');
            const doseVal = it.dose_value != null ? it.dose_value : (r.dose_value ?? '');
            const doseUnit = it.dose_unit != null ? it.dose_unit : (r.dose_unit ?? '');
            const note = r.dose_text ? ` • ${escapeHtml(r.dose_text)}` : '';
            const status = it.overridden ? `<span class="pill">edited</span>` : `<span class="pill blue">default</span>`;
            return `
                <div class="routine-item">
                    <div class="routine-left">
                        <div class="routine-title">${escapeHtml(r.name || 'Supplement')}${note}</div>
                        <div class="routine-meta">${status}</div>
                    </div>
                    <div class="routine-actions">
                        <div class="routine-yesno">
                            <button type="button" class="routine-yesno-btn ${taken ? 'active' : ''}" data-act="yes" data-id="${r.id}">Yes</button>
                            <button type="button" class="routine-yesno-btn ${!taken ? 'active' : ''}" data-act="no" data-id="${r.id}">No</button>
                        </div>
                        <input type="time" value="${escapeHtml(time)}" data-field="time_text" data-id="${r.id}" class="routine-time-input" style="min-width:140px;">
                        <input type="number" step="0.01" value="${doseVal ?? ''}" data-field="dose_value" data-id="${r.id}" class="routine-number-input" style="max-width:130px;">
                        <input type="text" value="${escapeHtml(String(doseUnit || ''))}" data-field="dose_unit" data-id="${r.id}" class="routine-text-input" style="max-width:120px;" placeholder="unit">
                        <button type="button" class="btn btn-secondary" data-act="clear" data-id="${r.id}" style="padding:8px 12px;">Revert</button>
                    </div>
                </div>
            `;
        }).join('');

        // Bind events
        box.querySelectorAll('button[data-act="yes"],button[data-act="no"]').forEach(btn => {
            btn.addEventListener('click', async () => {
                const id = Number(btn.getAttribute('data-id'));
                const act = btn.getAttribute('data-act');
                await saveSupplementOverride({ date, regimen_id: id, taken: act === 'yes' });
                await loadSupplementsDay();
            });
        });
        box.querySelectorAll('input[data-field]').forEach(inp => {
            inp.addEventListener('change', async () => {
                const id = Number(inp.getAttribute('data-id'));
                const field = inp.getAttribute('data-field');
                const value = inp.value;
                const payload = { date, regimen_id: id };
                payload[field] = field === 'dose_value' ? (value === '' ? null : Number(value)) : value;
                await saveSupplementOverride(payload);
                await loadSupplementsDay();
            });
        });
        box.querySelectorAll('button[data-act="clear"]').forEach(btn => {
            btn.addEventListener('click', async () => {
                const id = Number(btn.getAttribute('data-id'));
                await fetch('/api/supplements/day/clear', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ date, regimen_id: id })
                });
                await loadSupplementsDay();
            });
        });
    } catch (e) {
        box.innerHTML = `<div class="journal-item"><div class="journal-item__meta" style="color:#b91c1c;font-weight:900;">Network error</div></div>`;
    } finally {
        hideLoading();
    }
}

async function loadSupplementRegimens() {
    const box = document.getElementById('supplementRegimensList');
    if (!box) return;
    showLoading();
    try {
        const resp = await fetch('/api/supplements/regimens');
        const rows = await resp.json().catch(() => []);
        if (!resp.ok) {
            box.innerHTML = `<div class="routine-empty">${escapeHtml(rows.error || 'Failed to load')}</div>`;
            return;
        }
        if (!rows.length) {
            box.innerHTML = `<div class="routine-empty">No recurring supplements yet.</div>`;
            return;
        }
        box.innerHTML = rows.map(r => {
            const times = (r.default_times || []).filter(Boolean).join(', ');
            const dose = r.dose_value != null ? `${r.dose_value} ${escapeHtml(r.dose_unit || '')}`.trim() : (r.dose_text ? escapeHtml(r.dose_text) : '');
            const freq = r.frequency ? String(r.frequency) : 'daily';
            return `
                <div class="routine-item">
                    <div class="routine-left">
                        <div class="routine-title">${escapeHtml(r.name || 'Supplement')}</div>
                        <div class="routine-meta">${dose ? `Dose: ${dose}` : 'Dose: —'} • Time: ${times || '—'} • ${escapeHtml(freq)}</div>
                    </div>
                    <div class="routine-actions">
                        <button type="button" class="btn btn-secondary" data-regimen-del="${r.id}" style="padding:8px 12px;">
                            <i class="fas fa-trash"></i> Remove
                        </button>
                    </div>
                </div>
            `;
        }).join('');

        box.querySelectorAll('button[data-regimen-del]').forEach(btn => {
            btn.addEventListener('click', async () => {
                const id = Number(btn.getAttribute('data-regimen-del'));
                await fetch(`/api/supplements/regimens/${id}`, { method: 'DELETE' }).catch(() => { });
                await loadSupplementRegimens();
                await loadSupplementsDay().catch(() => { });
            });
        });
    } finally {
        hideLoading();
    }
}

async function saveSupplementOverride(payload) {
    await fetch('/api/supplements/day', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    }).catch(() => { });
}

async function handleSupplementRegimenSubmit(e) {
    e.preventDefault();
    const name = document.getElementById('suppRegName')?.value || '';
    const dose_value = document.getElementById('suppRegDoseValue')?.value || '';
    const dose_unit = document.getElementById('suppRegDoseUnit')?.value || '';
    const t1 = document.getElementById('suppRegTime1')?.value || '';
    const t2 = document.getElementById('suppRegTime2')?.value || '';
    const frequency = document.getElementById('suppRegFrequency')?.value || 'daily';
    const default_times = [t1, t2].filter(Boolean);

    showLoading();
    try {
        const resp = await fetch('/api/supplements/regimens', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name,
                dose_value: dose_value === '' ? null : Number(dose_value),
                dose_unit: dose_unit || null,
                frequency,
                default_times
            })
        });
        const out = await resp.json().catch(() => ({}));
        if (!resp.ok) {
            showNotification(out.error || 'Failed to add regimen', 'error');
            return;
        }
        showNotification('Regimen added', 'success');
        e.target.reset();
        await loadSupplementsDay();
        await loadSupplementRegimens().catch(() => { });
    } finally {
        hideLoading();
    }
}

async function handleMedicationsSubmit(e) {
    e.preventDefault();
    showLoading();

    const formData = new FormData(e.target);
    const data = Object.fromEntries(formData);

    try {
        const response = await fetch('/api/medications', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(data)
        });

        const result = await response.json();

        if (response.ok) {
            showNotification('Medication added successfully!', 'success');
            e.target.reset();
            setDefaultDates();
        } else {
            showNotification(result.error || 'Error adding medication', 'error');
        }
    } catch (error) {
        showNotification('Network error. Please try again.', 'error');
    } finally {
        hideLoading();
    }
}

async function loadMedicationsDay() {
    const dateEl = document.getElementById('medicationsDayDate');
    const box = document.getElementById('medicationsDayList');
    if (!dateEl || !box) return;
    if (!dateEl.value) dateEl.value = new Date().toISOString().split('T')[0];
    const date = dateEl.value;

    showLoading();
    try {
        const resp = await fetch(`/api/medications/day?date=${encodeURIComponent(date)}`);
        const items = await resp.json().catch(() => []);
        if (!resp.ok) {
            box.innerHTML = `<div class="routine-empty">${escapeHtml(items.error || 'Failed')}</div>`;
            return;
        }
        if (!items.length) {
            box.innerHTML = `<div class="routine-empty">No medication regimens yet. Add one below.</div>`;
            return;
        }
        box.innerHTML = items.map(it => {
            const r = it.regimen || {};
            const taken = !!it.taken;
            const time = it.time_text || (r.default_times?.[0] || '');
            const doseVal = it.dose_value != null ? it.dose_value : (r.dose_value ?? '');
            const doseUnit = it.dose_unit != null ? it.dose_unit : (r.dose_unit ?? '');
            const note = r.dose_text ? ` • ${escapeHtml(r.dose_text)}` : '';
            const status = it.overridden ? `<span class="pill">edited</span>` : `<span class="pill blue">default</span>`;
            return `
                <div class="routine-item">
                    <div class="routine-left">
                        <div class="routine-title">${escapeHtml(r.name || 'Medication')}${note}</div>
                        <div class="routine-meta">${status}</div>
                    </div>
                    <div class="routine-actions">
                        <div class="routine-yesno">
                            <button type="button" class="routine-yesno-btn ${taken ? 'active' : ''}" data-med-act="yes" data-id="${r.id}">Yes</button>
                            <button type="button" class="routine-yesno-btn ${!taken ? 'active' : ''}" data-med-act="no" data-id="${r.id}">No</button>
                        </div>
                        <input type="time" value="${escapeHtml(time)}" data-med-field="time_text" data-id="${r.id}" class="routine-time-input" style="min-width:140px;">
                        <input type="number" step="0.01" value="${doseVal ?? ''}" data-med-field="dose_value" data-id="${r.id}" class="routine-number-input" style="max-width:130px;">
                        <input type="text" value="${escapeHtml(String(doseUnit || ''))}" data-med-field="dose_unit" data-id="${r.id}" class="routine-text-input" style="max-width:120px;" placeholder="unit">
                        <button type="button" class="btn btn-secondary" data-med-act="clear" data-id="${r.id}" style="padding:8px 12px;">Revert</button>
                    </div>
                </div>
            `;
        }).join('');

        box.querySelectorAll('button[data-med-act="yes"],button[data-med-act="no"]').forEach(btn => {
            btn.addEventListener('click', async () => {
                const id = Number(btn.getAttribute('data-id'));
                const act = btn.getAttribute('data-med-act');
                await saveMedicationOverride({ date, regimen_id: id, taken: act === 'yes' });
                await loadMedicationsDay();
            });
        });
        box.querySelectorAll('input[data-med-field]').forEach(inp => {
            inp.addEventListener('change', async () => {
                const id = Number(inp.getAttribute('data-id'));
                const field = inp.getAttribute('data-med-field');
                const value = inp.value;
                const payload = { date, regimen_id: id };
                payload[field] = field === 'dose_value' ? (value === '' ? null : Number(value)) : value;
                await saveMedicationOverride(payload);
                await loadMedicationsDay();
            });
        });
        box.querySelectorAll('button[data-med-act="clear"]').forEach(btn => {
            btn.addEventListener('click', async () => {
                const id = Number(btn.getAttribute('data-id'));
                await fetch('/api/medications/day/clear', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ date, regimen_id: id })
                });
                await loadMedicationsDay();
            });
        });
    } catch (e) {
        box.innerHTML = `<div class="routine-empty">Network error</div>`;
    } finally {
        hideLoading();
    }
}

async function saveMedicationOverride(payload) {
    await fetch('/api/medications/day', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    }).catch(() => { });
}

async function loadMedicationRegimens() {
    const box = document.getElementById('medicationRegimensList');
    if (!box) return;
    showLoading();
    try {
        const resp = await fetch('/api/medications/regimens');
        const rows = await resp.json().catch(() => []);
        if (!resp.ok) {
            box.innerHTML = `<div class="routine-empty">${escapeHtml(rows.error || 'Failed to load')}</div>`;
            return;
        }
        if (!rows.length) {
            box.innerHTML = `<div class="routine-empty">No recurring medications yet.</div>`;
            return;
        }
        box.innerHTML = rows.map(r => {
            const times = (r.default_times || []).filter(Boolean).join(', ');
            const dose = r.dose_value != null ? `${r.dose_value} ${escapeHtml(r.dose_unit || '')}`.trim() : (r.dose_text ? escapeHtml(r.dose_text) : '');
            const freq = r.frequency ? String(r.frequency) : 'daily';
            return `
                <div class="routine-item">
                    <div class="routine-left">
                        <div class="routine-title">${escapeHtml(r.name || 'Medication')}</div>
                        <div class="routine-meta">${dose ? `Dose: ${dose}` : 'Dose: —'} • Time: ${times || '—'} • ${escapeHtml(freq)}</div>
                    </div>
                    <div class="routine-actions">
                        <button type="button" class="btn btn-secondary" data-med-regimen-del="${r.id}" style="padding:8px 12px;">
                            <i class="fas fa-trash"></i> Remove
                        </button>
                    </div>
                </div>
            `;
        }).join('');

        box.querySelectorAll('button[data-med-regimen-del]').forEach(btn => {
            btn.addEventListener('click', async () => {
                const id = Number(btn.getAttribute('data-med-regimen-del'));
                await fetch(`/api/medications/regimens/${id}`, { method: 'DELETE' }).catch(() => { });
                await loadMedicationRegimens();
                await loadMedicationsDay().catch(() => { });
            });
        });
    } finally {
        hideLoading();
    }
}

async function handleMedicationRegimenSubmit(e) {
    e.preventDefault();
    const name = document.getElementById('medRegName')?.value || '';
    const dose_value = document.getElementById('medRegDoseValue')?.value || '';
    const dose_unit = document.getElementById('medRegDoseUnit')?.value || '';
    const t1 = document.getElementById('medRegTime1')?.value || '';
    const t2 = document.getElementById('medRegTime2')?.value || '';
    const frequency = document.getElementById('medRegFrequency')?.value || 'daily';
    const default_times = [t1, t2].filter(Boolean);

    showLoading();
    try {
        const resp = await fetch('/api/medications/regimens', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name,
                dose_value: dose_value === '' ? null : Number(dose_value),
                dose_unit: dose_unit || null,
                frequency,
                default_times
            })
        });
        const out = await resp.json().catch(() => ({}));
        if (!resp.ok) {
            showNotification(out.error || 'Failed to add regimen', 'error');
            return;
        }
        showNotification('Regimen added', 'success');
        e.target.reset();
        await loadMedicationsDay().catch(() => { });
        await loadMedicationRegimens().catch(() => { });
    } finally {
        hideLoading();
    }
}

async function handleGeneticUpload(e) {
    e.preventDefault();

    const fileInput = document.getElementById('geneticFile');
    const file = fileInput.files[0];

    if (!file) {
        showNotification('Please select a file to upload', 'error');
        return;
    }

    // Check file type
    const allowedTypes = ['.csv', '.xlsx', '.xls'];
    const fileExtension = '.' + file.name.split('.').pop().toLowerCase();

    if (!allowedTypes.includes(fileExtension)) {
        showNotification('Please upload a CSV or Excel file (.csv, .xlsx, .xls)', 'error');
        return;
    }

    showLoading();

    const formData = new FormData(e.target);

    try {
        const response = await fetch('/api/genetic-upload', {
            method: 'POST',
            body: formData
        });

        let result;
        try {
            result = await response.json();
        } catch (parseError) {
            const text = await response.text();
            console.error('Response text:', text);
            showNotification('Server error: ' + (text || 'Invalid response'), 'error');
            hideLoading();
            return;
        }

        if (response.ok) {
            showNotification('Genetic data uploaded and analyzed successfully!', 'success');
            displayGeneticResults(result.analysis);
            e.target.reset();
            // Reload genetic data list to show the new upload
            loadGeneticData();
        } else {
            showNotification(result.error || 'Error uploading genetic data', 'error');
            console.error('Upload error:', result);
        }
    } catch (error) {
        console.error('Upload error:', error);
        showNotification('Network error: ' + error.message, 'error');
    } finally {
        hideLoading();
    }
}

// Dashboard Data Loading
async function loadDashboardData() {
    try {
        // Load all data types in parallel
        const [sleepData, activityData, nutritionData, moodData, foodLogData, settingsData, summaryData] = await Promise.all([
            fetch('/api/sleep').then(res => res.json()),
            fetch('/api/activity').then(res => res.json()),
            fetch('/api/nutrition').then(res => res.json()),
            fetch('/api/mood').then(res => res.json()),
            fetch('/api/food-log').then(res => res.json()),
            fetch('/api/user/settings').then(res => res.json()),
            fetch('/api/dashboard/summary').then(res => res.json())
        ]);

        currentData.sleep = sleepData;
        currentData.activity = activityData;
        currentData.nutrition = nutritionData;
        currentData.mood = moodData;
        currentData.foodLog = foodLogData;

        updateDashboardMetrics(summaryData, settingsData);
        createCharts();
        updateRecentEntries();
    } catch (error) {
        console.error('Error loading dashboard data:', error);
        showNotification('Error loading dashboard data', 'error');
    }
}

function updateDashboardMetrics(summaryData, settingsData = {}) {
    const isoLocal = (d) => {
        const x = new Date(d);
        // Use midday to avoid DST/UTC edge issues
        x.setHours(12, 0, 0, 0);
        const y = x.getFullYear();
        const m = String(x.getMonth() + 1).padStart(2, '0');
        const day = String(x.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
    };
    const fmtHours = (h) => (Number.isFinite(Number(h)) ? Number(h).toFixed(1) : null);
    const yesterdayIso = (() => {
        const d = new Date();
        d.setDate(d.getDate() - 1);
        return isoLocal(d);
    })();
    const todayIso = isoLocal(new Date());

    // Sleep: last sleep record (by date)
    const lastSleep = Array.isArray(currentData.sleep) && currentData.sleep.length
        ? [...currentData.sleep].sort((a, b) => String(b.date).localeCompare(String(a.date)))[0]
        : null;
    const sleepH = lastSleep ? fmtHours(lastSleep.duration_hours) : null;
    const deepH = lastSleep ? fmtHours(lastSleep.deep_sleep_hours) : null;
    const remH = lastSleep ? fmtHours(lastSleep.rem_sleep_hours) : null;

    document.getElementById('avgSleepScore').textContent = sleepH != null ? `${sleepH}h` : '--';
    const sleepTrend = document.getElementById('sleepTrend');
    if (sleepTrend) {
        if (!lastSleep) sleepTrend.textContent = '--';
        else sleepTrend.textContent = `Deep ${deepH ?? '--'}h • REM ${remH ?? '--'}h`;
    }

    // Steps: yesterday's steps (fallback to most recent with steps)
    const yAct = (Array.isArray(currentData.activity) ? currentData.activity : []).find(r => r.date === yesterdayIso)
        || (Array.isArray(currentData.activity) ? currentData.activity : []).find(r => r.steps != null);
    const stepsVal = yAct?.steps != null ? Number(yAct.steps) : null;
    document.getElementById('avgSteps').textContent = stepsVal != null && Number.isFinite(stepsVal) ? Math.round(stepsVal).toLocaleString() : '--';
    const stepsTrend = document.getElementById('stepsTrend');
    if (stepsTrend) stepsTrend.textContent = yAct?.date ? `Date: ${yAct.date}` : '--';

    // Mood: keep last 7 day average (unchanged)
    const avgMood = currentData.mood.length > 0
        ? (currentData.mood.reduce((sum, item) => sum + (item.mood_score || 0), 0) / currentData.mood.length).toFixed(1)
        : '--';
    document.getElementById('avgMood').textContent = avgMood;

    // Resting HR: yesterday's resting HR (fallback to most recent rhr)
    const yRhr = (Array.isArray(currentData.activity) ? currentData.activity : []).find(r => r.date === yesterdayIso)
        || (Array.isArray(currentData.activity) ? currentData.activity : []).find(r => r.rhr != null || r.resting_hr != null || r.resting_heart_rate != null);
    const rhrVal = yRhr ? (yRhr.rhr ?? yRhr.resting_hr ?? yRhr.resting_heart_rate) : null;
    const rhrNum = rhrVal != null ? Number(rhrVal) : null;
    document.getElementById('avgHeartRate').textContent = (rhrNum != null && Number.isFinite(rhrNum)) ? Math.round(rhrNum).toString() : '--';
    const hrTrend = document.getElementById('hrTrend');
    if (hrTrend) hrTrend.textContent = yRhr?.date ? `Date: ${yRhr.date}` : '--';

    // Calories: today's total calories (prefer nutrition_data; fallback to food_log sum)
    const todayNut = (Array.isArray(currentData.nutrition) ? currentData.nutrition : []).find(r => r.date === todayIso);
    const nutCalories = todayNut?.calories != null ? Number(todayNut.calories) : null;
    const foodCals = (Array.isArray(currentData.foodLog) ? currentData.foodLog : [])
        .filter(r => r.date === todayIso && r.calories != null)
        .map(r => Number(r.calories))
        .filter(n => Number.isFinite(n))
        .reduce((a, b) => a + b, 0);
    const caloriesToday = Number.isFinite(nutCalories) ? nutCalories : (foodCals > 0 ? foodCals : null);

    const calEl = document.getElementById('todayCalories');
    if (calEl) calEl.textContent = caloriesToday != null ? Math.round(caloriesToday).toLocaleString() : '--';

    const goal = settingsData?.calorie_goal_kcal != null ? Number(settingsData.calorie_goal_kcal) : null;
    const trend = document.getElementById('caloriesTrend');
    if (trend) {
        if (goal != null && Number.isFinite(goal) && goal > 0) {
            const remaining = caloriesToday != null ? Math.round(goal - caloriesToday) : null;
            trend.textContent = `Goal ${Math.round(goal).toLocaleString()} • ${remaining != null ? `Remaining ${remaining.toLocaleString()}` : 'Remaining --'}`;
        } else {
            trend.textContent = 'Set your daily calorie goal';
        }
    }

    // If goal missing, just show hint + button (avoid browser prompt blockers)
}

async function openCalorieGoalModal() {
    const existing = document.getElementById('calorieGoalModal');
    if (!existing) {
        const modal = document.createElement('div');
        modal.id = 'calorieGoalModal';
        modal.style.position = 'fixed';
        modal.style.inset = '0';
        modal.style.background = 'rgba(15, 23, 42, 0.55)';
        modal.style.backdropFilter = 'blur(6px)';
        modal.style.display = 'flex';
        modal.style.alignItems = 'center';
        modal.style.justifyContent = 'center';
        modal.style.zIndex = '3000';
        modal.innerHTML = `
            <div style="width:min(520px, 92vw); background:rgba(255,255,255,.98); border-radius:18px; padding:16px; box-shadow:0 18px 50px rgba(0,0,0,.25); border:1px solid rgba(255,255,255,.7);">
                <div style="display:flex; align-items:center; justify-content:space-between; gap:10px;">
                    <div style="font-weight:900; color:#111827; font-size:16px;">Daily calorie goal</div>
                    <button type="button" id="calGoalCloseBtn" class="btn btn-secondary" style="padding:8px 12px; box-shadow:none;">Close</button>
                </div>
                <div style="margin-top:12px; color:#6b7280; font-weight:800;">Set your target calories per day (kcal). You can change this anytime.</div>
                <div style="margin-top:12px; display:flex; gap:10px; align-items:end; flex-wrap:wrap;">
                    <div style="flex:1; min-width:220px;">
                        <label style="display:block; font-weight:900; color:#374151; margin-bottom:6px;">Goal (kcal)</label>
                        <input type="number" id="calGoalInput" min="1" max="20000" step="1" placeholder="e.g. 2200" style="width:100%; padding:12px 12px; border-radius:12px; border:1px solid rgba(229,231,235,.95); font-weight:900;">
                    </div>
                    <button type="button" id="calGoalSaveBtn" class="btn btn-primary" style="padding:12px 16px;">
                        <i class="fas fa-save"></i> Save
                    </button>
                </div>
                <div id="calGoalHint" style="margin-top:10px; color:#6b7280; font-weight:800; font-size:13px;"></div>
            </div>
        `;
        document.body.appendChild(modal);

        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeCalorieGoalModal();
        });
        modal.querySelector('#calGoalCloseBtn')?.addEventListener('click', closeCalorieGoalModal);
        modal.querySelector('#calGoalSaveBtn')?.addEventListener('click', () => saveCalorieGoalFromModal().catch(() => { }));
    }

    // Load current goal into modal
    try {
        const resp = await fetch('/api/user/settings');
        const out = await resp.json().catch(() => ({}));
        const v = out?.calorie_goal_kcal;
        const input = document.getElementById('calGoalInput');
        if (input) input.value = v != null ? String(v) : '';
        const hint = document.getElementById('calGoalHint');
        if (hint) hint.textContent = v != null ? `Current goal: ${v} kcal/day` : 'No goal set yet.';
    } catch { }

    document.getElementById('calorieGoalModal').style.display = 'flex';
    setTimeout(() => document.getElementById('calGoalInput')?.focus(), 50);
}

function closeCalorieGoalModal() {
    const modal = document.getElementById('calorieGoalModal');
    if (modal) modal.style.display = 'none';
}

async function saveCalorieGoalFromModal() {
    const input = document.getElementById('calGoalInput');
    const hint = document.getElementById('calGoalHint');
    const n = Number(String(input?.value || '').trim());
    if (!Number.isFinite(n) || n <= 0) {
        showNotification('Please enter a valid number of kcal', 'error');
        return;
    }
    showLoading();
    try {
        const resp = await fetch('/api/user/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ calorie_goal_kcal: Math.round(n) })
        });
        const out = await resp.json().catch(() => ({}));
        if (!resp.ok) {
            showNotification(out.error || 'Failed to save goal', 'error');
            return;
        }
        if (hint) hint.textContent = `Saved: ${out.calorie_goal_kcal} kcal/day`;
        showNotification('Calorie goal saved', 'success');
        closeCalorieGoalModal();
        loadDashboardData();
    } finally {
        hideLoading();
    }
}

function createCharts() {
    createSleepChart();
    createActivityChart();
    createMoodChart();
    createNutritionChart();
}

function createSleepChart() {
    const ctx = document.getElementById('sleepChart').getContext('2d');

    if (charts.sleepChart) {
        charts.sleepChart.destroy();
    }

    const last7Days = getLast7Days();
    const hasScores = currentData.sleep.some(item => item.score != null);
    const sleepData = last7Days.map(date => {
        const dayData = currentData.sleep.find(item => item.date === date);
        if (!dayData) return null;
        return hasScores ? dayData.score : dayData.duration_hours;
    });

    charts.sleepChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: last7Days.map(date => new Date(date).toLocaleDateString('en-US', { weekday: 'short' })),
            datasets: [{
                label: hasScores ? 'Sleep Score' : 'Sleep Duration (h)',
                data: sleepData,
                borderColor: '#667eea',
                backgroundColor: 'rgba(102, 126, 234, 0.1)',
                borderWidth: 3,
                fill: true,
                tension: 0.4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: false
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    max: hasScores ? 10 : undefined,
                    grid: {
                        color: 'rgba(0, 0, 0, 0.1)'
                    }
                },
                x: {
                    grid: {
                        display: false
                    }
                }
            }
        }
    });
}

function createActivityChart() {
    const ctx = document.getElementById('activityChart').getContext('2d');

    if (charts.activityChart) {
        charts.activityChart.destroy();
    }

    const last7Days = getLast7Days();
    const stepsData = last7Days.map(date => {
        const dayData = currentData.activity.find(item => item.date === date);
        return dayData ? dayData.steps : 0;
    });

    charts.activityChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: last7Days.map(date => new Date(date).toLocaleDateString('en-US', { weekday: 'short' })),
            datasets: [{
                label: 'Steps',
                data: stepsData,
                backgroundColor: 'rgba(102, 126, 234, 0.8)',
                borderColor: '#667eea',
                borderWidth: 1
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: false
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    grid: {
                        color: 'rgba(0, 0, 0, 0.1)'
                    }
                },
                x: {
                    grid: {
                        display: false
                    }
                }
            }
        }
    });
}

function createMoodChart() {
    const ctx = document.getElementById('moodChart').getContext('2d');

    if (charts.moodChart) {
        charts.moodChart.destroy();
    }

    const last7Days = getLast7Days();
    const moodData = last7Days.map(date => {
        const dayData = currentData.mood.find(item => item.date === date);
        return dayData ? dayData.mood_score : null;
    });

    const energyData = last7Days.map(date => {
        const dayData = currentData.mood.find(item => item.date === date);
        return dayData ? dayData.energy_score : null;
    });

    charts.moodChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: last7Days.map(date => new Date(date).toLocaleDateString('en-US', { weekday: 'short' })),
            datasets: [{
                label: 'Mood',
                data: moodData,
                borderColor: '#48bb78',
                backgroundColor: 'rgba(72, 187, 120, 0.1)',
                borderWidth: 3,
                fill: false,
                tension: 0.4
            }, {
                label: 'Energy',
                data: energyData,
                borderColor: '#ed8936',
                backgroundColor: 'rgba(237, 137, 54, 0.1)',
                borderWidth: 3,
                fill: false,
                tension: 0.4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'top'
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    max: 10,
                    grid: {
                        color: 'rgba(0, 0, 0, 0.1)'
                    }
                },
                x: {
                    grid: {
                        display: false
                    }
                }
            }
        }
    });
}

function createNutritionChart() {
    const ctx = document.getElementById('nutritionChart').getContext('2d');

    if (charts.nutritionChart) {
        charts.nutritionChart.destroy();
    }

    const last7Days = getLast7Days();
    const proteinData = last7Days.map(date => {
        const dayData = currentData.nutrition.find(item => item.date === date);
        return dayData ? dayData.protein_g || 0 : 0;
    });

    const carbsData = last7Days.map(date => {
        const dayData = currentData.nutrition.find(item => item.date === date);
        return dayData ? dayData.carbs_g || 0 : 0;
    });

    const fatData = last7Days.map(date => {
        const dayData = currentData.nutrition.find(item => item.date === date);
        return dayData ? dayData.fat_g || 0 : 0;
    });

    charts.nutritionChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: ['Protein', 'Carbs', 'Fat'],
            datasets: [{
                data: [
                    proteinData.reduce((sum, val) => sum + val, 0),
                    carbsData.reduce((sum, val) => sum + val, 0),
                    fatData.reduce((sum, val) => sum + val, 0)
                ],
                backgroundColor: [
                    '#667eea',
                    '#48bb78',
                    '#ed8936'
                ],
                borderWidth: 0
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'bottom'
                }
            }
        }
    });
}

function getLast7Days() {
    const days = [];
    for (let i = 6; i >= 0; i--) {
        const date = new Date();
        date.setDate(date.getDate() - i);
        days.push(date.toISOString().split('T')[0]);
    }
    return days;
}

function updateRecentEntries() {
    const recentEntriesList = document.getElementById('recentEntriesList');
    const allEntries = [];

    // Combine all data types with timestamps
    currentData.sleep.forEach(item => {
        allEntries.push({
            type: 'Sleep',
            date: item.date,
            details: `Score: ${item.score}, Duration: ${item.duration_hours}h`,
            timestamp: new Date(item.created_at || item.date)
        });
    });

    currentData.activity.forEach(item => {
        allEntries.push({
            type: 'Activity',
            date: item.date,
            details: `Steps: ${item.steps?.toLocaleString()}, Calories: ${item.calories_burned}`,
            timestamp: new Date(item.created_at || item.date)
        });
    });

    currentData.mood.forEach(item => {
        allEntries.push({
            type: 'Mood',
            date: item.date,
            details: `Mood: ${item.mood_score}, Energy: ${item.energy_score}`,
            timestamp: new Date(item.created_at || item.date)
        });
    });

    currentData.nutrition.forEach(item => {
        allEntries.push({
            type: 'Nutrition',
            date: item.date,
            details: `Calories: ${item.calories}, Protein: ${item.protein_g}g`,
            timestamp: new Date(item.created_at || item.date)
        });
    });

    // Sort by timestamp and take last 5
    allEntries.sort((a, b) => b.timestamp - a.timestamp);
    const recentEntries = allEntries.slice(0, 5);

    if (recentEntries.length === 0) {
        recentEntriesList.innerHTML = '<p class="text-center" style="color: #718096; font-style: italic;">No recent entries found. Start tracking your health data!</p>';
        return;
    }

    recentEntriesList.innerHTML = recentEntries.map(entry => `
        <div class="entry-item">
            <div style="display: flex; justify-content: space-between; align-items: center;">
                <div>
                    <strong>${entry.type}</strong> - ${entry.date}
                    <div style="color: #718096; font-size: 14px; margin-top: 5px;">${entry.details}</div>
                </div>
                <div style="color: #a0aec0; font-size: 12px;">
                    ${entry.timestamp.toLocaleDateString()}
                </div>
            </div>
        </div>
    `).join('');
}

// Analysis Functions
async function runCorrelationAnalysis() {
    showLoading();

    try {
        // Simulate correlation analysis
        await new Promise(resolve => setTimeout(resolve, 2000));

        const correlations = [
            { factor1: 'Sleep Score', factor2: 'Mood Score', correlation: 0.72, pValue: 0.001 },
            { factor1: 'Steps', factor2: 'Energy Score', correlation: 0.58, pValue: 0.02 },
            { factor1: 'Sleep Duration', factor2: 'Stress Score', correlation: -0.45, pValue: 0.05 }
        ];

        displayCorrelationResults(correlations);
        showNotification('Correlation analysis completed!', 'success');
    } catch (error) {
        showNotification('Error running correlation analysis', 'error');
    } finally {
        hideLoading();
    }
}

function displayCorrelationResults(correlations) {
    const resultsDiv = document.getElementById('correlationResults');

    if (correlations.length === 0) {
        resultsDiv.innerHTML = '<p>No significant correlations found.</p>';
        return;
    }

    resultsDiv.innerHTML = correlations.map(corr => `
        <div style="background: white; border-radius: 8px; padding: 15px; margin-bottom: 10px; border-left: 4px solid #667eea;">
            <div style="font-weight: 600; color: #4a5568; margin-bottom: 5px;">
                ${corr.factor1} ↔ ${corr.factor2}
            </div>
            <div style="color: #718096; font-size: 14px;">
                Correlation: ${corr.correlation.toFixed(3)} | P-value: ${corr.pValue.toFixed(3)}
                <span style="margin-left: 10px; padding: 2px 8px; border-radius: 4px; font-size: 12px; background: ${corr.pValue < 0.05 ? '#48bb78' : '#ed8936'}; color: white;">
                    ${corr.pValue < 0.05 ? 'Significant' : 'Not Significant'}
                </span>
            </div>
        </div>
    `).join('');
}

async function checkDrugInteractions() {
    showLoading();

    try {
        // Simulate drug interaction check
        await new Promise(resolve => setTimeout(resolve, 1500));

        const interactions = [
            {
                drug1: 'Vitamin D',
                drug2: 'Calcium',
                severity: 'Minor',
                description: 'May increase calcium absorption'
            },
            {
                drug1: 'Omega-3',
                drug2: 'Blood Thinners',
                severity: 'Moderate',
                description: 'May increase bleeding risk'
            }
        ];

        displayInteractionResults(interactions);
        showNotification('Drug interaction check completed!', 'success');
    } catch (error) {
        showNotification('Error checking drug interactions', 'error');
    } finally {
        hideLoading();
    }
}

function displayInteractionResults(interactions) {
    const resultsDiv = document.getElementById('interactionResults');

    if (interactions.length === 0) {
        resultsDiv.innerHTML = '<p>No significant drug interactions found.</p>';
        return;
    }

    resultsDiv.innerHTML = interactions.map(interaction => `
        <div style="background: white; border-radius: 8px; padding: 15px; margin-bottom: 10px; border-left: 4px solid ${interaction.severity === 'Major' ? '#f56565' : interaction.severity === 'Moderate' ? '#ed8936' : '#48bb78'};">
            <div style="font-weight: 600; color: #4a5568; margin-bottom: 5px;">
                ${interaction.drug1} + ${interaction.drug2}
            </div>
            <div style="color: #718096; font-size: 14px; margin-bottom: 5px;">
                ${interaction.description}
            </div>
            <span style="padding: 2px 8px; border-radius: 4px; font-size: 12px; background: ${interaction.severity === 'Major' ? '#f56565' : interaction.severity === 'Moderate' ? '#ed8936' : '#48bb78'}; color: white;">
                ${interaction.severity} Risk
            </span>
        </div>
    `).join('');
}

async function generateRecommendations() {
    showLoading();

    try {
        // Simulate recommendation generation
        await new Promise(resolve => setTimeout(resolve, 2000));

        const recommendations = [
            {
                category: 'Sleep',
                recommendation: 'Try to maintain consistent sleep schedule. Your sleep quality correlates with mood.',
                priority: 'High'
            },
            {
                category: 'Activity',
                recommendation: 'Increase daily steps to 10,000 for better energy levels.',
                priority: 'Medium'
            },
            {
                category: 'Nutrition',
                recommendation: 'Consider increasing protein intake to support muscle recovery.',
                priority: 'Low'
            }
        ];

        displayRecommendations(recommendations);
        showNotification('Recommendations generated!', 'success');
    } catch (error) {
        showNotification('Error generating recommendations', 'error');
    } finally {
        hideLoading();
    }
}

function displayRecommendations(recommendations) {
    const resultsDiv = document.getElementById('recommendationsResults');

    resultsDiv.innerHTML = recommendations.map(rec => `
        <div style="background: white; border-radius: 8px; padding: 15px; margin-bottom: 10px; border-left: 4px solid ${rec.priority === 'High' ? '#f56565' : rec.priority === 'Medium' ? '#ed8936' : '#48bb78'};">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                <div style="font-weight: 600; color: #4a5568;">
                    ${rec.category}
                </div>
                <span style="padding: 2px 8px; border-radius: 4px; font-size: 12px; background: ${rec.priority === 'High' ? '#f56565' : rec.priority === 'Medium' ? '#ed8936' : '#48bb78'}; color: white;">
                    ${rec.priority} Priority
                </span>
            </div>
            <div style="color: #718096; font-size: 14px;">
                ${rec.recommendation}
            </div>
        </div>
    `).join('');
}

// Genetic Data Functions
function displayGeneticResults(analysis) {
    const resultsDiv = document.getElementById('geneticResults');

    resultsDiv.innerHTML = `
        <div style="background: white; border-radius: 8px; padding: 20px;">
            <h4 style="color: #4a5568; margin-bottom: 15px;">Analysis Summary</h4>
            <div style="margin-bottom: 15px;">
                <strong>Total SNPs Analyzed:</strong> ${analysis.totalSNPs}
            </div>
            <div style="margin-bottom: 15px;">
                <strong>Analysis Date:</strong> ${new Date(analysis.analysisDate).toLocaleDateString()}
            </div>
            
            <h5 style="color: #4a5568; margin: 20px 0 10px 0;">Recommendations:</h5>
            <ul style="color: #718096; margin-bottom: 20px;">
                ${analysis.recommendations.map(rec => `<li>${rec}</li>`).join('')}
            </ul>
            
            <h5 style="color: #4a5568; margin: 20px 0 10px 0;">Risk Factors:</h5>
            <ul style="color: #718096;">
                ${analysis.riskFactors.map(risk => `<li>${risk}</li>`).join('')}
            </ul>
        </div>
    `;
}

async function loadGeneticData() {
    try {
        const response = await fetch('/api/genetic-data');
        const geneticData = await response.json();

        if (response.ok) {
            displayGeneticDataList(geneticData);
        } else {
            console.error('Error loading genetic data:', geneticData.error);
        }
    } catch (error) {
        console.error('Error loading genetic data:', error);
    }
}

function displayGeneticDataList(geneticDataList) {
    const resultsDiv = document.getElementById('geneticResults');

    if (geneticDataList.length === 0) {
        resultsDiv.innerHTML = `
            <div style="text-align: center; color: #718096; padding: 40px;">
                <i class="fas fa-dna" style="font-size: 3rem; margin-bottom: 20px; opacity: 0.3;"></i>
                <p>No genetic data uploaded yet.</p>
                <p style="font-size: 14px; margin-top: 10px;">Upload a CSV or Excel file above to get started.</p>
            </div>
        `;
        return;
    }

    resultsDiv.innerHTML = `
        <div style="margin-bottom: 20px;">
            <h4 style="color: #4a5568; margin-bottom: 15px;">
                <i class="fas fa-list"></i> Uploaded Genetic Data Files (${geneticDataList.length})
            </h4>
        </div>
        ${geneticDataList.map((data, index) => `
            <div style="background: white; border-radius: 12px; padding: 20px; margin-bottom: 15px; border-left: 4px solid #667eea; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
                <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 15px;">
                    <div style="flex: 1;">
                        <h5 style="color: #4a5568; margin-bottom: 8px; display: flex; align-items: center; gap: 10px;">
                            <i class="fas fa-file-excel" style="color: #667eea;"></i>
                            ${data.filename}
                        </h5>
                        <div style="color: #718096; font-size: 14px;">
                            <div><strong>Uploaded:</strong> ${new Date(data.uploaded_at).toLocaleString()}</div>
                            <div style="margin-top: 5px;"><strong>File ID:</strong> #${data.id}</div>
                        </div>
                    </div>
                    <button onclick="viewGeneticData(${data.id})" class="btn btn-primary" style="padding: 8px 16px; font-size: 14px;">
                        <i class="fas fa-eye"></i> View Details
                    </button>
                </div>
                
                ${data.analysis_results ? `
                    <div style="background: rgba(102, 126, 234, 0.05); border-radius: 8px; padding: 15px; margin-top: 15px;">
                        <div style="margin-bottom: 10px;">
                            <strong style="color: #4a5568;">Total SNPs Analyzed:</strong> 
                            <span style="color: #667eea; font-weight: 600;">${data.analysis_results.totalSNPs || 'N/A'}</span>
                        </div>
                        <div style="margin-top: 10px;">
                            <strong style="color: #4a5568;">Key Recommendations:</strong>
                            <ul style="color: #718096; margin-top: 8px; margin-left: 20px;">
                                ${data.analysis_results.recommendations ?
                data.analysis_results.recommendations.slice(0, 3).map(rec => `<li>${rec}</li>`).join('')
                : '<li>No recommendations available</li>'}
                            </ul>
                        </div>
                    </div>
                ` : '<p style="color: #718096; font-style: italic;">Analysis pending...</p>'}
            </div>
        `).join('')}
    `;
}

async function viewGeneticData(id) {
    try {
        showLoading();
        const response = await fetch(`/api/genetic-data/${id}`);
        const data = await response.json();

        if (response.ok) {
            displayGeneticDataDetails(data);
        } else {
            showNotification(data.error || 'Error loading genetic data', 'error');
        }
    } catch (error) {
        showNotification('Network error loading genetic data', 'error');
    } finally {
        hideLoading();
    }
}

function displayGeneticDataDetails(data) {
    const resultsDiv = document.getElementById('geneticResults');

    // Parse CSV data to show preview
    const csvLines = data.data.split('\n').slice(0, 11); // First 10 rows
    const csvPreview = csvLines.join('\n');
    const totalRows = data.data.split('\n').length;

    resultsDiv.innerHTML = `
        <div style="margin-bottom: 20px;">
            <button onclick="loadGeneticData()" class="btn btn-secondary" style="margin-bottom: 15px;">
                <i class="fas fa-arrow-left"></i> Back to List
            </button>
        </div>
        
        <div style="background: white; border-radius: 12px; padding: 25px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
            <h4 style="color: #4a5568; margin-bottom: 20px; display: flex; align-items: center; gap: 10px;">
                <i class="fas fa-file-excel" style="color: #667eea;"></i>
                ${data.filename}
            </h4>
            
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin-bottom: 25px;">
                <div style="background: rgba(102, 126, 234, 0.05); padding: 15px; border-radius: 8px;">
                    <div style="color: #718096; font-size: 14px; margin-bottom: 5px;">Upload Date</div>
                    <div style="color: #4a5568; font-weight: 600;">${new Date(data.uploaded_at).toLocaleDateString()}</div>
                </div>
                <div style="background: rgba(102, 126, 234, 0.05); padding: 15px; border-radius: 8px;">
                    <div style="color: #718096; font-size: 14px; margin-bottom: 5px;">Total Rows</div>
                    <div style="color: #4a5568; font-weight: 600;">${totalRows}</div>
                </div>
                ${data.analysis_results ? `
                    <div style="background: rgba(102, 126, 234, 0.05); padding: 15px; border-radius: 8px;">
                        <div style="color: #718096; font-size: 14px; margin-bottom: 5px;">SNPs Analyzed</div>
                        <div style="color: #4a5568; font-weight: 600;">${data.analysis_results.totalSNPs || 'N/A'}</div>
                    </div>
                ` : ''}
            </div>
            
            ${data.analysis_results ? `
                <div style="margin-bottom: 25px;">
                    <h5 style="color: #4a5568; margin-bottom: 15px;">
                        <i class="fas fa-chart-line"></i> Analysis Results
                    </h5>
                    
                    <div style="background: rgba(102, 126, 234, 0.05); border-radius: 8px; padding: 20px; margin-bottom: 15px;">
                        <h6 style="color: #4a5568; margin-bottom: 10px;">Recommendations:</h6>
                        <ul style="color: #718096; margin-left: 20px;">
                            ${data.analysis_results.recommendations ?
                data.analysis_results.recommendations.map(rec => `<li style="margin-bottom: 8px;">${rec}</li>`).join('')
                : '<li>No recommendations available</li>'}
                        </ul>
                    </div>
                    
                    <div style="background: rgba(237, 137, 54, 0.05); border-radius: 8px; padding: 20px;">
                        <h6 style="color: #4a5568; margin-bottom: 10px;">Risk Factors:</h6>
                        <ul style="color: #718096; margin-left: 20px;">
                            ${data.analysis_results.riskFactors ?
                data.analysis_results.riskFactors.map(risk => `<li style="margin-bottom: 8px;">${risk}</li>`).join('')
                : '<li>No risk factors identified</li>'}
                        </ul>
                    </div>
                </div>
            ` : ''}
            
            <div>
                <h5 style="color: #4a5568; margin-bottom: 15px;">
                    <i class="fas fa-table"></i> Data Preview (First ${csvLines.length} rows)
                </h5>
                <div style="background: #f7fafc; border-radius: 8px; padding: 15px; overflow-x: auto; font-family: 'Courier New', monospace; font-size: 12px; max-height: 400px; overflow-y: auto;">
                    <pre style="margin: 0; color: #4a5568; white-space: pre-wrap;">${csvPreview}</pre>
                    ${totalRows > csvLines.length ? `<div style="color: #718096; margin-top: 10px; font-style: italic;">... and ${totalRows - csvLines.length} more rows</div>` : ''}
                </div>
            </div>
        </div>
    `;
}

// Make viewGeneticData globally available
window.viewGeneticData = viewGeneticData;

async function loadAnalysisData() {
    // Placeholder for loading analysis data
    console.log('Loading analysis data...');
}

// Load and display imported Garmin data
async function loadGarminData() {
    try {
        const response = await fetch('/api/garmin-data');
        const data = await response.json();

        if (response.ok) {
            displayGarminData(data);
        } else {
            console.error('Error loading Garmin data:', data.error);
        }
    } catch (error) {
        console.error('Error loading Garmin data:', error);
    }
}

// Trends (single place to review everything)
async function loadTrendsTab() {
    const fromEl = document.getElementById('trendsFrom');
    const toEl = document.getElementById('trendsTo');
    const tableEl = document.getElementById('trendsTable');
    const hrvHintEl = document.getElementById('trendHrvHint');

    const today = new Date();
    const todayIso = today.toISOString().split('T')[0];
    const d30 = new Date();
    d30.setDate(d30.getDate() - 30);
    const d30Iso = d30.toISOString().split('T')[0];

    if (fromEl && !fromEl.value) fromEl.value = d30Iso;
    if (toEl && !toEl.value) toEl.value = todayIso;

    const applyQuick30 = () => {
        if (fromEl) fromEl.value = d30Iso;
        if (toEl) toEl.value = todayIso;
        loadTrendsTab().catch(() => { });
    };

    const btn30 = document.getElementById('trendsLast30Btn');
    if (btn30 && !btn30.dataset.bound) {
        btn30.dataset.bound = '1';
        btn30.addEventListener('click', applyQuick30);
    }
    const btnRefresh = document.getElementById('trendsRefreshBtn');
    if (btnRefresh && !btnRefresh.dataset.bound) {
        btnRefresh.dataset.bound = '1';
        btnRefresh.addEventListener('click', () => loadTrendsTab().catch(() => { }));
    }

    const from = fromEl?.value || d30Iso;
    const to = toEl?.value || todayIso;

    showLoading();
    try {
        // Load core tables + workouts
        const [sleepRows, activityRows, bodyRows, workouts, hrDaily, rhrDaily, hrvDaily] = await Promise.all([
            fetch('/api/sleep').then(r => r.json()).catch(() => []),
            fetch('/api/activity').then(r => r.json()).catch(() => []),
            fetch(`/api/bodycomp?limit=365`).then(r => r.json()).catch(() => []),
            fetch(`/api/workouts?limit=2000`).then(r => r.json()).catch(() => []),
            fetch(`/api/biometrics/series?type=heart_rate&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`).then(r => r.json()).catch(() => []),
            fetch(`/api/biometrics/series?type=resting_heart_rate&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`).then(r => r.json()).catch(() => []),
            fetch(`/api/biometrics/series?type=hrv&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`).then(r => r.json()).catch(() => [])
        ]);

        // Filter by date range for table-based sources
        const inRange = (d) => d && d >= from && d <= to;
        const sleepIn = (sleepRows || []).filter(r => inRange(r.date));
        const actIn = (activityRows || []).filter(r => inRange(r.date));
        const bodyIn = (bodyRows || []).filter(r => inRange(r.date));
        const workoutsIn = (workouts || []).filter(w => inRange(w.date));

        // Heart rate daily: if we have biometric samples, prefer those; otherwise fall back to activity_data.heart_rate_avg
        const labels = [];
        const day = new Date(from);
        const end = new Date(to);
        while (day <= end) {
            labels.push(day.toISOString().split('T')[0]);
            day.setDate(day.getDate() + 1);
        }

        const hrMap = new Map((hrDaily || []).map(r => [r.day, r.avg]));
        const hrFromActivity = new Map(actIn.map(r => [r.date, r.heart_rate_avg]));
        const hrSeries = labels.map(d => {
            if (hrMap.has(d)) return hrMap.get(d);
            const v = hrFromActivity.get(d);
            return v == null ? null : Number(v);
        });

        const rhrMap = new Map((rhrDaily || []).map(r => [r.day, r.avg]));
        const rhrSeries = labels.map(d => rhrMap.has(d) ? rhrMap.get(d) : null);

        const hrvMap = new Map((hrvDaily || []).map(r => [r.day, r.avg]));
        const hrvSeries = labels.map(d => hrvMap.has(d) ? hrvMap.get(d) : null);
        if (hrvHintEl) {
            const any = hrvSeries.some(v => v != null);
            hrvHintEl.textContent = any ? '' : 'No HRV data imported yet (will appear once we import HRV samples into biometrics).';
        }

        const sleepDur = labels.map(d => {
            const row = sleepIn.find(r => r.date === d);
            return row?.duration_hours != null ? Number(row.duration_hours) : null;
        });

        const steps = labels.map(d => {
            const row = actIn.find(r => r.date === d);
            return row?.steps != null ? Number(row.steps) : null;
        });

        const weight = labels.map(d => {
            const row = bodyIn.find(r => r.date === d);
            return row?.weight_kg != null ? Number(row.weight_kg) : null;
        });

        // Charts
        const ensureChart = (key, canvasId, label, data, color) => {
            const canvas = document.getElementById(canvasId);
            if (!canvas) return;
            const ctx = canvas.getContext('2d');
            if (charts[key]) charts[key].destroy();
            charts[key] = new Chart(ctx, {
                type: 'line',
                data: {
                    labels: labels.map(d => new Date(d).toLocaleDateString()),
                    datasets: [{
                        label,
                        data,
                        borderColor: color,
                        backgroundColor: 'rgba(102, 126, 234, 0.08)',
                        borderWidth: 2,
                        fill: true,
                        tension: 0.35,
                        pointRadius: 1.5
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { display: false } },
                    scales: { x: { grid: { display: false } } }
                }
            });
        };

        ensureChart('trendHeartRateChart', 'trendHeartRateChart', 'HR', hrSeries, '#ef4444');
        ensureChart('trendRestingHrChart', 'trendRestingHrChart', 'Resting HR', rhrSeries, '#f97316');
        ensureChart('trendHrvChart', 'trendHrvChart', 'HRV', hrvSeries, '#06b6d4');
        ensureChart('trendSleepDurationChart', 'trendSleepDurationChart', 'Sleep (h)', sleepDur, '#667eea');
        ensureChart('trendStepsChart', 'trendStepsChart', 'Steps', steps, '#22c55e');
        ensureChart('trendWeightChart', 'trendWeightChart', 'Weight (kg)', weight, '#a855f7');

        // Auto-generate charts for every Garmin metric we actually have data for
        const allBox = document.getElementById('trendsAllMetrics');
        if (allBox) {
            allBox.innerHTML = '';

            const addMetricChart = (id, title, series, color) => {
                if (!series.some(v => v != null && !Number.isNaN(Number(v)))) return;
                const wrap = document.createElement('div');
                wrap.className = 'chart-container';
                wrap.innerHTML = `<h3>${escapeHtml(title)}</h3><canvas id="${escapeHtml(id)}"></canvas>`;
                allBox.appendChild(wrap);
                ensureChart(id, id, title, series.map(v => (v == null ? null : Number(v))), color);
            };

            // Garmin daily_summary fields that land in activity_data (plus a few manual fields)
            const byDay = new Map(actIn.map(r => [r.date, r]));
            const seriesOf = (field) => labels.map(d => {
                const row = byDay.get(d);
                const v = row ? row[field] : null;
                return v == null ? null : Number(v);
            });

            const dailyMetrics = [
                ['garmin_steps', 'Garmin: Steps', 'steps', '#22c55e'],
                ['garmin_distance', 'Garmin: Distance (km)', 'distance_km', '#0ea5e9'],
                ['garmin_active_minutes', 'Garmin: Intensity minutes (active minutes)', 'active_minutes', '#16a34a'],
                ['garmin_intensity_goal', 'Garmin: Intensity minutes goal (min)', 'intensity_time_goal_minutes', '#22c55e'],
                ['garmin_calories_burned', 'Garmin: Calories (total)', 'calories_burned', '#f59e0b'],
                ['garmin_calories_goal', 'Garmin: Calories goal', 'calories_goal', '#fbbf24'],
                ['garmin_calories_bmr', 'Garmin: Calories BMR', 'calories_bmr', '#f97316'],
                ['garmin_calories_active', 'Garmin: Calories active', 'calories_active', '#fb7185'],
                ['garmin_calories_consumed', 'Garmin: Calories consumed', 'calories_consumed', '#ef4444'],
                ['garmin_stress_avg', 'Garmin: Stress (daily avg)', 'stress_avg', '#a855f7'],
                ['garmin_body_battery_max', 'Garmin: Body Battery (max)', 'body_battery_max', '#8b5cf6'],
                ['garmin_body_battery_min', 'Garmin: Body Battery (min)', 'body_battery_min', '#7c3aed'],
                ['garmin_body_battery_charged', 'Garmin: Body Battery (charged)', 'body_battery_charged', '#6d28d9'],
                ['garmin_spo2_avg', 'Garmin: SpO2 (avg)', 'spo2_avg', '#06b6d4'],
                ['garmin_spo2_min', 'Garmin: SpO2 (min)', 'spo2_min', '#0891b2'],
                ['garmin_rr_waking_avg', 'Garmin: Respiration (waking avg)', 'rr_waking_avg', '#14b8a6'],
                ['garmin_rr_max', 'Garmin: Respiration (max)', 'rr_max', '#0d9488'],
                ['garmin_rr_min', 'Garmin: Respiration (min)', 'rr_min', '#0f766e'],
                ['garmin_floors_up', 'Garmin: Floors up', 'floors_up', '#64748b'],
                ['garmin_floors_down', 'Garmin: Floors down', 'floors_down', '#94a3b8'],
                ['garmin_floors_goal', 'Garmin: Floors goal', 'floors_goal', '#cbd5e1'],
                ['garmin_hr_min', 'Garmin: HR min', 'hr_min', '#ef4444'],
                ['garmin_hr_max', 'Garmin: HR max', 'hr_max', '#dc2626'],
                ['garmin_rhr_daily', 'Garmin: RHR (from daily summary)', 'rhr', '#f97316'],
                ['garmin_hydration_intake', 'Garmin: Hydration intake', 'hydration_intake', '#3b82f6'],
                ['garmin_hydration_goal', 'Garmin: Hydration goal', 'hydration_goal', '#60a5fa'],
                ['garmin_sweat_loss', 'Garmin: Sweat loss', 'sweat_loss', '#38bdf8']
            ];
            dailyMetrics.forEach(([id, title, field, color]) => addMetricChart(id, title, seriesOf(field), color));

            // Sleep metrics from sleep_data
            const sleepByDay = new Map(sleepIn.map(r => [r.date, r]));
            const sleepSeries = (field) => labels.map(d => {
                const row = sleepByDay.get(d);
                const v = row ? row[field] : null;
                return v == null ? null : Number(v);
            });
            addMetricChart('garmin_sleep_score', 'Garmin: Sleep score', sleepSeries('score'), '#667eea');
            addMetricChart('garmin_sleep_duration', 'Garmin: Sleep duration (h)', sleepSeries('duration_hours'), '#4f46e5');
            addMetricChart('garmin_sleep_deep', 'Garmin: Deep sleep (h)', sleepSeries('deep_sleep_hours'), '#4338ca');
            addMetricChart('garmin_sleep_rem', 'Garmin: REM sleep (h)', sleepSeries('rem_sleep_hours'), '#3730a3');

            // Training metrics from imported Garmin workouts
            const workoutsByDay = new Map();
            for (const w of workoutsIn) {
                const key = w.date;
                if (!key) continue;
                const arr = workoutsByDay.get(key) || [];
                arr.push(w);
                workoutsByDay.set(key, arr);
            }
            const workoutAgg = (field) => labels.map(d => {
                const arr = workoutsByDay.get(d) || [];
                const vals = arr.map(x => x[field]).filter(v => v != null).map(Number).filter(n => !Number.isNaN(n));
                if (!vals.length) return null;
                // average across workouts that day
                return vals.reduce((a, b) => a + b, 0) / vals.length;
            });
            addMetricChart('garmin_training_load', 'Garmin: Training load (avg/day)', workoutAgg('training_load'), '#111827');
            addMetricChart('garmin_training_effect', 'Garmin: Training effect (avg/day)', workoutAgg('training_effect'), '#334155');
            addMetricChart('garmin_anaerobic_training_effect', 'Garmin: Anaerobic training effect (avg/day)', workoutAgg('anaerobic_training_effect'), '#475569');
            addMetricChart('garmin_vo2_max', 'Garmin: VO2 max (avg/day)', workoutAgg('vo2_max'), '#0f172a');
        }

        // Table (latest 30 days in range)
        if (tableEl) {
            const rows = labels.slice(-30).reverse().map(d => {
                const s = sleepIn.find(r => r.date === d);
                const a = actIn.find(r => r.date === d);
                const b = bodyIn.find(r => r.date === d);
                return {
                    day: d,
                    sleep_h: s?.duration_hours != null ? Number(s.duration_hours).toFixed(1) : '',
                    steps: a?.steps != null ? Number(a.steps).toLocaleString() : '',
                    hr: (hrMap.get(d) ?? a?.heart_rate_avg) ?? '',
                    rhr: rhrMap.get(d) ?? '',
                    weight: b?.weight_kg != null ? Number(b.weight_kg).toFixed(1) : ''
                };
            });

            tableEl.innerHTML = `
                <div style="overflow:auto;">
                    <table style="width:100%; border-collapse:collapse; font-size:14px;">
                        <thead>
                            <tr style="text-align:left; color:#6b7280;">
                                <th style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">Date</th>
                                <th style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">Sleep (h)</th>
                                <th style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">Steps</th>
                                <th style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">HR</th>
                                <th style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">RHR</th>
                                <th style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">Weight</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${rows.map(r => `
                                <tr>
                                    <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.06);">${escapeHtml(r.day)}</td>
                                    <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.06);">${escapeHtml(String(r.sleep_h))}</td>
                                    <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.06);">${escapeHtml(String(r.steps))}</td>
                                    <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.06);">${escapeHtml(String(r.hr))}</td>
                                    <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.06);">${escapeHtml(String(r.rhr))}</td>
                                    <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.06);">${escapeHtml(String(r.weight))}</td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
            `;
        }
    } catch (e) {
        if (tableEl) tableEl.innerHTML = `<div class="journal-item"><div class="journal-item__meta" style="color:#b91c1c;font-weight:900;">Failed to load trends</div></div>`;
    } finally {
        hideLoading();
    }
}

function displayGarminData(data) {
    // Find or create the data view section
    let dataViewSection = document.getElementById('garminDataView');

    if (!dataViewSection) {
        // Create the section if it doesn't exist
        const garminContainer = document.querySelector('.garmin-container');
        if (garminContainer) {
            dataViewSection = document.createElement('div');
            dataViewSection.id = 'garminDataView';
            dataViewSection.className = 'garmin-section';
            garminContainer.insertBefore(dataViewSection, garminContainer.firstChild);
        } else {
            return;
        }
    }

    const summary = data.summary || {};
    const totalRecords = summary.totalActivities + summary.totalSleepRecords + summary.totalHeartRateRecords + summary.totalStressRecords;

    if (totalRecords === 0) {
        dataViewSection.innerHTML = `
            <h3><i class="fas fa-database"></i> Imported Data</h3>
            <div style="text-align: center; padding: 32px 10px;">
                <i class="fas fa-inbox" style="font-size: 3rem; margin-bottom: 16px; opacity: 0.25;"></i>
                <p>No imported data yet.</p>
                <p style="font-size: 14px; margin-top: 10px; color: #6b7280;">Upload Garmin files to see your data here.</p>
            </div>
        `;
        return;
    }

    dataViewSection.innerHTML = `
        <h3><i class="fas fa-database"></i> Imported Data Overview</h3>
        
        <!-- Summary Statistics -->
        <div class="data-summary-grid">
            <div class="stat-card stat-card--blue">
                <div class="stat-card__label">Total Records</div>
                <div class="stat-card__value">${totalRecords}</div>
            </div>
            <div class="stat-card stat-card--green">
                <div class="stat-card__label">Activity Records</div>
                <div class="stat-card__value">${summary.totalActivities || 0}</div>
            </div>
            <div class="stat-card stat-card--orange">
                <div class="stat-card__label">Sleep Records</div>
                <div class="stat-card__value">${summary.totalSleepRecords || 0}</div>
            </div>
            <div class="stat-card stat-card--red">
                <div class="stat-card__label">Heart Rate Records</div>
                <div class="stat-card__value">${summary.totalHeartRateRecords || 0}</div>
            </div>
        </div>
        
        ${summary.dateRange && summary.dateRange.earliest ? `
            <div class="info-panel" style="margin-bottom: 18px;">
                <div class="info-panel__title">Date Range</div>
                <div style="color: #374151;">
                    <strong>From:</strong> ${new Date(summary.dateRange.earliest).toLocaleDateString()}
                    <strong style="margin-left: 18px;">To:</strong> ${new Date(summary.dateRange.latest).toLocaleDateString()}
                </div>
            </div>
        ` : ''}
        
        ${summary.averages && (summary.averages.steps || summary.averages.calories || summary.averages.heartRate || summary.averages.sleepDuration) ? `
            <div class="info-panel" style="margin-bottom: 22px;">
                <div class="info-panel__title">Average Values</div>
                <div class="info-grid">
                    ${summary.averages.steps ? `
                        <div class="info-metric">
                            <div class="info-metric__label">Avg Steps</div>
                            <div class="info-metric__value">${summary.averages.steps.toLocaleString()}</div>
                        </div>
                    ` : ''}
                    ${summary.averages.calories ? `
                        <div class="info-metric">
                            <div class="info-metric__label">Avg Calories</div>
                            <div class="info-metric__value">${summary.averages.calories.toLocaleString()}</div>
                        </div>
                    ` : ''}
                    ${summary.averages.heartRate ? `
                        <div class="info-metric">
                            <div class="info-metric__label">Avg Heart Rate</div>
                            <div class="info-metric__value">${summary.averages.heartRate} bpm</div>
                        </div>
                    ` : ''}
                    ${summary.averages.sleepDuration ? `
                        <div class="info-metric">
                            <div class="info-metric__label">Avg Sleep Duration</div>
                            <div class="info-metric__value">${summary.averages.sleepDuration} hrs</div>
                        </div>
                    ` : ''}
                    ${summary.averages.sleepScore ? `
                        <div class="info-metric">
                            <div class="info-metric__label">Avg Sleep Score</div>
                            <div class="info-metric__value">${summary.averages.sleepScore}/10</div>
                        </div>
                    ` : ''}
                </div>
            </div>
        ` : ''}
        
        <!-- Data Tables -->
        <div style="display: grid; gap: 26px;">
            ${data.activities && data.activities.length > 0 ? `
                <div>
                    <h4 style="color: #4a5568; margin-bottom: 15px;">
                        <i class="fas fa-walking"></i> Activity Data (${data.activities.length} records)
                    </h4>
                    <div class="table-card">
                        <div class="table-scroll">
                            <table class="data-table">
                                <thead>
                                    <tr>
                                        <th>Date</th>
                                        <th class="num">Steps</th>
                                        <th class="num">Calories</th>
                                        <th class="num">Heart Rate</th>
                                        <th class="num">Active Min</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${data.activities.slice(0, 50).map(activity => `
                                        <tr>
                                            <td>${new Date(activity.date).toLocaleDateString()}</td>
                                            <td class="num">${activity.steps ? activity.steps.toLocaleString() : '-'}</td>
                                            <td class="num">${activity.calories_burned ? activity.calories_burned.toLocaleString() : '-'}</td>
                                            <td class="num">${activity.heart_rate_avg ? activity.heart_rate_avg + ' bpm' : '-'}</td>
                                            <td class="num">${activity.active_minutes || '-'}</td>
                                        </tr>
                                    `).join('')}
                                </tbody>
                            </table>
                        </div>
                        ${data.activities.length > 50 ? `
                            <div class="table-footer-note">
                                Showing first 50 of ${data.activities.length} records. View all data in the Dashboard.
                            </div>
                        ` : ''}
                    </div>
                </div>
            ` : ''}
            
            ${data.sleep && data.sleep.length > 0 ? `
                <div>
                    <h4 style="color: #4a5568; margin-bottom: 15px;">
                        <i class="fas fa-bed"></i> Sleep Data (${data.sleep.length} records)
                    </h4>
                    <div class="table-card">
                        <div class="table-scroll">
                            <table class="data-table">
                                <thead>
                                    <tr>
                                        <th>Date</th>
                                        <th class="num">Score</th>
                                        <th class="num">Duration</th>
                                        <th class="num">Deep</th>
                                        <th class="num">REM</th>
                                        <th class="num">Bedtime</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${data.sleep.slice(0, 50).map(sleep => `
                                        <tr>
                                            <td>${new Date(sleep.date).toLocaleDateString()}</td>
                                            <td class="num">${sleep.score || '-'}</td>
                                            <td class="num">${sleep.duration_hours ? sleep.duration_hours + 'h' : '-'}</td>
                                            <td class="num">${sleep.deep_sleep_hours ? sleep.deep_sleep_hours + 'h' : '-'}</td>
                                            <td class="num">${sleep.rem_sleep_hours ? sleep.rem_sleep_hours + 'h' : '-'}</td>
                                            <td class="num">${sleep.bedtime || '-'}</td>
                                        </tr>
                                    `).join('')}
                                </tbody>
                            </table>
                        </div>
                        ${data.sleep.length > 50 ? `
                            <div class="table-footer-note">
                                Showing first 50 of ${data.sleep.length} records. View all data in the Dashboard.
                            </div>
                        ` : ''}
                    </div>
                </div>
            ` : ''}
        </div>
    `;
}

// Labs / Biomarkers
let labsChart = null;

async function loadLabsTab() {
    // bind handlers once
    const labsForm = document.getElementById('labsForm');
    if (labsForm && !labsForm.dataset.bound) {
        labsForm.dataset.bound = '1';
        labsForm.addEventListener('submit', handleLabsSubmit);
    }
    const importForm = document.getElementById('labsImportForm');
    if (importForm && !importForm.dataset.bound) {
        importForm.dataset.bound = '1';
        importForm.addEventListener('submit', handleLabsImport);
    }
    const refreshBtn = document.getElementById('labsRefreshBtn');
    if (refreshBtn && !refreshBtn.dataset.bound) {
        refreshBtn.dataset.bound = '1';
        refreshBtn.addEventListener('click', () => loadLabsTab().catch(() => { }));
    }

    // default date
    const dateEl = document.getElementById('labsDate');
    if (dateEl && !dateEl.value) dateEl.value = new Date().toISOString().split('T')[0];

    showLoading();
    try {
        const [biomarkers, latest] = await Promise.all([
            fetch('/api/labs/biomarkers').then(r => r.json()).catch(() => []),
            fetch('/api/labs?limit=200').then(r => r.json()).catch(() => [])
        ]);

        renderLabsSelect(biomarkers);
        renderLabsList(latest);

        const selected = document.getElementById('labsSelect')?.value;
        if (selected) {
            await renderLabsChart(selected);
        }
    } catch (e) {
        const list = document.getElementById('labsList');
        if (list) list.innerHTML = `<div class="journal-item"><div class="journal-item__meta" style="color:#b91c1c;font-weight:900;">Failed to load labs</div></div>`;
    } finally {
        hideLoading();
    }
}

function renderLabsSelect(items) {
    const sel = document.getElementById('labsSelect');
    if (!sel) return;
    const prev = sel.value;
    const opts = (items || []).map(x => x.biomarker).filter(Boolean);
    sel.innerHTML = opts.length
        ? opts.map(b => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`).join('')
        : `<option value="">No biomarkers yet</option>`;
    if (prev && opts.includes(prev)) sel.value = prev;
    sel.onchange = () => {
        const v = sel.value;
        if (v) renderLabsChart(v);
    };
}

function renderLabsList(rows) {
    const box = document.getElementById('labsList');
    if (!box) return;
    const data = rows || [];
    if (!data.length) {
        box.innerHTML = `<div class="journal-item"><div class="journal-item__title">No lab results yet</div><div class="journal-item__meta">Add a result above or import a CSV/Excel.</div></div>`;
        return;
    }
    box.innerHTML = `
        <div style="overflow:auto;">
            <table style="width:100%; border-collapse:collapse; font-size:14px;">
                <thead>
                    <tr style="text-align:left; color:#6b7280;">
                        <th style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">Date</th>
                        <th style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">Biomarker</th>
                        <th style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">Value</th>
                        <th style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">Unit</th>
                        <th style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">Ref</th>
                        <th style="padding:10px; border-bottom:1px solid rgba(0,0,0,.08);">Source</th>
                    </tr>
                </thead>
                <tbody>
                    ${data.map(r => {
        const val = r.value_num != null ? r.value_num : (r.value_text || '');
        const ref = (r.ref_low != null || r.ref_high != null)
            ? `${r.ref_low != null ? r.ref_low : ''}–${r.ref_high != null ? r.ref_high : ''}`
            : '';
        return `
                            <tr>
                                <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.06);">${escapeHtml(String(r.date || ''))}</td>
                                <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.06); font-weight:700;">${escapeHtml(String(r.biomarker || ''))}</td>
                                <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.06);">${escapeHtml(String(val ?? ''))}</td>
                                <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.06);">${escapeHtml(String(r.unit || ''))}</td>
                                <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.06);">${escapeHtml(String(ref))}</td>
                                <td style="padding:10px; border-bottom:1px solid rgba(0,0,0,.06);">${escapeHtml(String(r.source || ''))}</td>
                            </tr>
                        `;
    }).join('')}
                </tbody>
            </table>
        </div>
    `;
}

async function renderLabsChart(biomarker) {
    const titleEl = document.getElementById('labsChartTitle');
    if (titleEl) titleEl.textContent = biomarker;

    const rows = await fetch(`/api/labs?biomarker=${encodeURIComponent(biomarker)}&limit=2000`).then(r => r.json()).catch(() => []);
    const points = (rows || [])
        .filter(r => r.date)
        .map(r => ({
            day: r.date,
            value: r.value_num != null ? Number(r.value_num) : null
        }))
        .filter(p => p.value != null && !Number.isNaN(p.value))
        .sort((a, b) => a.day.localeCompare(b.day));

    const canvas = document.getElementById('labsChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (labsChart) labsChart.destroy();

    labsChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: points.map(p => new Date(p.day).toLocaleDateString()),
            datasets: [{
                label: biomarker,
                data: points.map(p => p.value),
                borderColor: '#667eea',
                backgroundColor: 'rgba(102, 126, 234, 0.1)',
                borderWidth: 2,
                fill: true,
                tension: 0.35,
                pointRadius: 2
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: { x: { grid: { display: false } } }
        }
    });
}

async function handleLabsSubmit(e) {
    e.preventDefault();
    showLoading();
    try {
        const formData = new FormData(e.target);
        const data = Object.fromEntries(formData);
        const payload = {
            date: data.date,
            biomarker: data.biomarker,
            value_num: data.value_num,
            value_text: data.value_text,
            unit: data.unit,
            ref_low: data.ref_low,
            ref_high: data.ref_high,
            notes: data.notes,
            source: 'manual'
        };
        const resp = await fetch('/api/labs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const out = await resp.json().catch(() => ({}));
        if (!resp.ok) {
            showNotification(out.error || 'Failed to save lab result', 'error');
            return;
        }
        showNotification('Lab result saved', 'success');
        e.target.reset();
        const dateEl = document.getElementById('labsDate');
        if (dateEl) dateEl.value = new Date().toISOString().split('T')[0];
        await loadLabsTab();
    } catch (err) {
        showNotification('Network error saving lab result', 'error');
    } finally {
        hideLoading();
    }
}

async function handleLabsImport(e) {
    e.preventDefault();
    const resultsEl = document.getElementById('labsImportResults');
    if (resultsEl) resultsEl.innerHTML = `<div class="journal-item"><div class="journal-item__meta">Importing…</div></div>`;
    showLoading();
    try {
        const formData = new FormData(e.target);
        const resp = await fetch('/api/labs/import', { method: 'POST', body: formData });
        const out = await resp.json().catch(() => ({}));
        if (!resp.ok) {
            if (resultsEl) resultsEl.innerHTML = `<div class="journal-item"><div class="journal-item__meta" style="color:#b91c1c;font-weight:900;">${escapeHtml(out.error || 'Failed')}</div></div>`;
            return;
        }
        if (resultsEl) {
            resultsEl.innerHTML = `
                <div class="journal-item">
                    <div class="journal-item__title">Labs import complete</div>
                    <div class="journal-item__meta">Inserted ${escapeHtml(String(out.inserted || 0))} rows (parsed ${escapeHtml(String(out.rows_parsed || 0))})</div>
                    ${out.errors && out.errors.length ? `<div class="journal-item__meta" style="margin-top:8px;color:#6b7280;">Some rows had issues (showing up to 25).</div>` : ''}
                </div>
            `;
        }
        showNotification('Labs imported', 'success');
        await loadLabsTab();
    } catch (err) {
        if (resultsEl) resultsEl.innerHTML = `<div class="journal-item"><div class="journal-item__meta" style="color:#b91c1c;font-weight:900;">Network error importing labs</div></div>`;
    } finally {
        hideLoading();
    }
}

// Garmin Integration
async function handleGarminUpload(e) {
    e.preventDefault();

    const fileInput = document.getElementById('garminFile');
    const file = fileInput.files[0];

    if (!file) {
        showNotification('Please select a Garmin data file to upload', 'error');
        return;
    }

    // Check file type
    const allowedTypes = ['.csv', '.xlsx', '.xls', '.tcx', '.gpx'];
    const fileExtension = '.' + file.name.split('.').pop().toLowerCase();

    if (!allowedTypes.includes(fileExtension)) {
        showNotification('Please upload a Garmin file (.csv, .xlsx, .xls, .tcx, .gpx)', 'error');
        return;
    }

    showLoading();

    const formData = new FormData(e.target);
    const resultsDiv = document.getElementById('garminImportResults');

    try {
        const response = await fetch('/api/garmin-upload', {
            method: 'POST',
            body: formData
        });

        let result;
        try {
            result = await response.json();
        } catch (parseError) {
            const text = await response.text();
            console.error('Response text:', text);
            showNotification('Server error: ' + (text || 'Invalid response'), 'error');
            hideLoading();
            return;
        }

        if (response.ok) {
            // Display import results
            const imported = result.imported || {};
            const totalImported = (imported.activities || 0) + (imported.sleep || 0) + (imported.heartRate || 0) + (imported.stress || 0);

            resultsDiv.innerHTML = `
                <div style="background: rgba(72, 187, 120, 0.1); border-radius: 12px; padding: 20px; border-left: 4px solid #48bb78;">
                    <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 15px;">
                        <i class="fas fa-check-circle" style="color: #48bb78; font-size: 24px;"></i>
                        <h4 style="color: #4a5568; margin: 0;">Garmin Data Imported Successfully!</h4>
                    </div>
                    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 15px; margin-bottom: 15px;">
                        ${imported.activities > 0 ? `
                            <div style="background: white; padding: 12px; border-radius: 8px;">
                                <div style="color: #718096; font-size: 12px; margin-bottom: 5px;">Activities</div>
                                <div style="color: #4a5568; font-size: 20px; font-weight: 600;">${imported.activities}</div>
                            </div>
                        ` : ''}
                        ${imported.sleep > 0 ? `
                            <div style="background: white; padding: 12px; border-radius: 8px;">
                                <div style="color: #718096; font-size: 12px; margin-bottom: 5px;">Sleep Records</div>
                                <div style="color: #4a5568; font-size: 20px; font-weight: 600;">${imported.sleep}</div>
                            </div>
                        ` : ''}
                        ${imported.heartRate > 0 ? `
                            <div style="background: white; padding: 12px; border-radius: 8px;">
                                <div style="color: #718096; font-size: 12px; margin-bottom: 5px;">Heart Rate</div>
                                <div style="color: #4a5568; font-size: 20px; font-weight: 600;">${imported.heartRate}</div>
                            </div>
                        ` : ''}
                        ${imported.stress > 0 ? `
                            <div style="background: white; padding: 12px; border-radius: 8px;">
                                <div style="color: #718096; font-size: 12px; margin-bottom: 5px;">Stress Data</div>
                                <div style="color: #4a5568; font-size: 20px; font-weight: 600;">${imported.stress}</div>
                            </div>
                        ` : ''}
                    </div>
                    ${result.errors && result.errors.length > 0 ? `
                        <div style="background: rgba(237, 137, 54, 0.1); border-radius: 8px; padding: 12px; margin-top: 15px;">
                            <div style="color: #ed8936; font-weight: 600; margin-bottom: 8px;">Some errors occurred:</div>
                            <ul style="color: #718096; font-size: 12px; margin: 0; padding-left: 20px;">
                                ${result.errors.slice(0, 5).map(err => `<li>${err}</li>`).join('')}
                            </ul>
                        </div>
                    ` : ''}
                    <div style="color: #718096; font-size: 14px; margin-top: 15px;">
                        Total records imported: <strong>${totalImported}</strong>
                    </div>
                </div>
            `;

            showNotification(`Successfully imported ${totalImported} records from Garmin data!`, 'success');
            e.target.reset();

            // Reload Garmin data view to show imported data
            loadGarminData();

            // Reload dashboard to show new data
            if (document.getElementById('dashboard').classList.contains('active')) {
                loadDashboardData();
            }
        } else {
            resultsDiv.innerHTML = `
                <div style="background: rgba(245, 101, 101, 0.1); border-radius: 12px; padding: 20px; border-left: 4px solid #f56565;">
                    <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 10px;">
                        <i class="fas fa-exclamation-circle" style="color: #f56565; font-size: 24px;"></i>
                        <h4 style="color: #4a5568; margin: 0;">Import Failed</h4>
                    </div>
                    <p style="color: #718096; margin: 0;">${result.error || 'Unknown error occurred'}</p>
                </div>
            `;
            showNotification(result.error || 'Error importing Garmin data', 'error');
        }
    } catch (error) {
        console.error('Garmin upload error:', error);
        resultsDiv.innerHTML = `
            <div style="background: rgba(245, 101, 101, 0.1); border-radius: 12px; padding: 20px; border-left: 4px solid #f56565;">
                <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 10px;">
                    <i class="fas fa-exclamation-circle" style="color: #f56565; font-size: 24px;"></i>
                    <h4 style="color: #4a5568; margin: 0;">Network Error</h4>
                </div>
                <p style="color: #718096; margin: 0;">${error.message}</p>
            </div>
        `;
        showNotification('Network error: ' + error.message, 'error');
    } finally {
        hideLoading();
    }
}

// Apple Health Import (upload export.xml)
async function handleAppleHealthUpload(e) {
    e.preventDefault();
    const fileInput = document.getElementById('appleHealthFile');
    const file = fileInput?.files?.[0];
    const resultsDiv = document.getElementById('appleHealthImportResults');

    if (!file) {
        showNotification('Please select Apple Health export.xml to upload', 'error');
        return;
    }
    const ext = '.' + file.name.split('.').pop().toLowerCase();
    if (ext !== '.xml') {
        showNotification('Please upload export.xml (.xml)', 'error');
        return;
    }

    showLoading();
    const formData = new FormData(e.target);
    try {
        const response = await fetch('/api/apple-health/import', { method: 'POST', body: formData });
        let result;
        try {
            result = await response.json();
        } catch (parseError) {
            const text = await response.text();
            showNotification('Server error: ' + (text || 'Invalid response'), 'error');
            return;
        }

        if (response.ok) {
            const imported = result.imported || {};
            resultsDiv.innerHTML = `
                <div style="background: rgba(72, 187, 120, 0.1); border-radius: 12px; padding: 20px; border-left: 4px solid #48bb78;">
                    <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 15px;">
                        <i class="fas fa-check-circle" style="color: #48bb78; font-size: 24px;"></i>
                        <h4 style="color: #4a5568; margin: 0;">Apple Health Imported Successfully!</h4>
                    </div>
                    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 15px; margin-bottom: 15px;">
                        <div style="background: white; padding: 12px; border-radius: 8px;">
                            <div style="color: #718096; font-size: 12px; margin-bottom: 5px;">Days (Steps/HR)</div>
                            <div style="color: #4a5568; font-size: 20px; font-weight: 600;">${imported.activity_days || 0}</div>
                        </div>
                        <div style="background: white; padding: 12px; border-radius: 8px;">
                            <div style="color: #718096; font-size: 12px; margin-bottom: 5px;">Days (Sleep)</div>
                            <div style="color: #4a5568; font-size: 20px; font-weight: 600;">${imported.sleep_days || 0}</div>
                        </div>
                        <div style="background: white; padding: 12px; border-radius: 8px;">
                            <div style="color: #718096; font-size: 12px; margin-bottom: 5px;">Records Parsed</div>
                            <div style="color: #4a5568; font-size: 20px; font-weight: 600;">${imported.records_parsed || 0}</div>
                        </div>
                    </div>
                    <div style="color: #718096; font-size: 14px; margin-top: 10px;">
                        Imported types: <strong>Steps</strong>, <strong>Heart Rate</strong>, <strong>Sleep</strong>
                    </div>
                </div>
            `;
            showNotification('Apple Health data imported!', 'success');
            e.target.reset();
            // Reload dashboard to show new data
            if (document.getElementById('dashboard').classList.contains('active')) {
                loadDashboardData();
            }
        } else {
            resultsDiv.innerHTML = `
                <div style="background: rgba(245, 101, 101, 0.1); border-radius: 12px; padding: 20px; border-left: 4px solid #f56565;">
                    <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 10px;">
                        <i class="fas fa-exclamation-circle" style="color: #f56565; font-size: 24px;"></i>
                        <h4 style="color: #4a5568; margin: 0;">Import Failed</h4>
                    </div>
                    <p style="color: #718096; margin: 0;">${result.error || 'Unknown error occurred'}</p>
                </div>
            `;
            showNotification(result.error || 'Error importing Apple Health', 'error');
        }
    } catch (error) {
        console.error('Apple Health upload error:', error);
        if (resultsDiv) {
            resultsDiv.innerHTML = `
                <div style="background: rgba(245, 101, 101, 0.1); border-radius: 12px; padding: 20px; border-left: 4px solid #f56565;">
                    <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 10px;">
                        <i class="fas fa-exclamation-circle" style="color: #f56565; font-size: 24px;"></i>
                        <h4 style="color: #4a5568; margin: 0;">Network Error</h4>
                    </div>
                    <p style="color: #718096; margin: 0;">${escapeHtml(error.message || 'Unknown error')}</p>
                </div>
            `;
        }
        showNotification('Network error: ' + error.message, 'error');
    } finally {
        hideLoading();
    }
}

// Android Import (Google Takeout ZIP or extracted CSV)
async function handleAndroidHealthUpload(e) {
    e.preventDefault();
    const fileInput = document.getElementById('androidHealthFile');
    const file = fileInput?.files?.[0];
    const resultsDiv = document.getElementById('androidHealthImportResults');

    if (!file) {
        showNotification('Please select a Google Fit Takeout ZIP (or CSV) to upload', 'error');
        return;
    }
    const ext = '.' + file.name.split('.').pop().toLowerCase();
    if (!['.zip', '.csv'].includes(ext)) {
        showNotification('Please upload a .zip or .csv file', 'error');
        return;
    }

    showLoading();
    const formData = new FormData(e.target);
    try {
        const response = await fetch('/api/android-health/import', { method: 'POST', body: formData });
        let result;
        try {
            result = await response.json();
        } catch (parseError) {
            const text = await response.text();
            showNotification('Server error: ' + (text || 'Invalid response'), 'error');
            return;
        }

        if (response.ok) {
            const imported = result.imported || {};
            resultsDiv.innerHTML = `
                <div style="background: rgba(72, 187, 120, 0.1); border-radius: 12px; padding: 20px; border-left: 4px solid #48bb78;">
                    <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 15px;">
                        <i class="fas fa-check-circle" style="color: #48bb78; font-size: 24px;"></i>
                        <h4 style="color: #4a5568; margin: 0;">Android Data Imported Successfully!</h4>
                    </div>
                    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 15px; margin-bottom: 15px;">
                        <div style="background: white; padding: 12px; border-radius: 8px;">
                            <div style="color: #718096; font-size: 12px; margin-bottom: 5px;">Days (Steps/HR)</div>
                            <div style="color: #4a5568; font-size: 20px; font-weight: 600;">${imported.activity_days || 0}</div>
                        </div>
                        <div style="background: white; padding: 12px; border-radius: 8px;">
                            <div style="color: #718096; font-size: 12px; margin-bottom: 5px;">Days (Sleep)</div>
                            <div style="color: #4a5568; font-size: 20px; font-weight: 600;">${imported.sleep_days || 0}</div>
                        </div>
                        <div style="background: white; padding: 12px; border-radius: 8px;">
                            <div style="color: #718096; font-size: 12px; margin-bottom: 5px;">Files Parsed</div>
                            <div style="color: #4a5568; font-size: 20px; font-weight: 600;">${imported.files_parsed || 0}</div>
                        </div>
                    </div>
                    ${imported.warnings && imported.warnings.length ? `
                        <div style="background: rgba(237, 137, 54, 0.1); border-radius: 8px; padding: 12px; margin-top: 10px;">
                            <div style="color: #ed8936; font-weight: 600; margin-bottom: 8px;">Notes:</div>
                            <ul style="color: #718096; font-size: 12px; margin: 0; padding-left: 20px;">
                                ${imported.warnings.slice(0, 6).map(w => `<li>${escapeHtml(w)}</li>`).join('')}
                            </ul>
                        </div>
                    ` : ''}
                </div>
            `;
            showNotification('Android data imported!', 'success');
            e.target.reset();
            if (document.getElementById('dashboard').classList.contains('active')) {
                loadDashboardData();
            }
        } else {
            resultsDiv.innerHTML = `
                <div style="background: rgba(245, 101, 101, 0.1); border-radius: 12px; padding: 20px; border-left: 4px solid #f56565;">
                    <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 10px;">
                        <i class="fas fa-exclamation-circle" style="color: #f56565; font-size: 24px;"></i>
                        <h4 style="color: #4a5568; margin: 0;">Import Failed</h4>
                    </div>
                    <p style="color: #718096; margin: 0;">${result.error || 'Unknown error occurred'}</p>
                </div>
            `;
            showNotification(result.error || 'Error importing Android data', 'error');
        }
    } catch (error) {
        console.error('Android upload error:', error);
        if (resultsDiv) {
            resultsDiv.innerHTML = `
                <div style="background: rgba(245, 101, 101, 0.1); border-radius: 12px; padding: 20px; border-left: 4px solid #f56565;">
                    <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 10px;">
                        <i class="fas fa-exclamation-circle" style="color: #f56565; font-size: 24px;"></i>
                        <h4 style="color: #4a5568; margin: 0;">Network Error</h4>
                    </div>
                    <p style="color: #718096; margin: 0;">${escapeHtml(error.message || 'Unknown error')}</p>
                </div>
            `;
        }
        showNotification('Network error: ' + error.message, 'error');
    } finally {
        hideLoading();
    }
}

async function exportData() {
    try {
        // Create export data
        const exportData = {
            sleep: currentData.sleep,
            activity: currentData.activity,
            nutrition: currentData.nutrition,
            mood: currentData.mood,
            exportDate: new Date().toISOString()
        };

        // Create and download file
        const dataStr = JSON.stringify(exportData, null, 2);
        const dataBlob = new Blob([dataStr], { type: 'application/json' });
        const url = URL.createObjectURL(dataBlob);

        const link = document.createElement('a');
        link.href = url;
        link.download = `health-data-export-${new Date().toISOString().split('T')[0]}.json`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);

        showNotification('Data exported successfully!', 'success');
    } catch (error) {
        showNotification('Error exporting data', 'error');
    }
}

// Utility Functions
function showLoading() {
    document.getElementById('loadingOverlay').classList.add('show');
}

function hideLoading() {
    document.getElementById('loadingOverlay').classList.remove('show');
}

function showNotification(message, type = 'info') {
    const toast = document.getElementById('notificationToast');
    const icon = toast.querySelector('.toast-icon');
    const messageEl = toast.querySelector('.toast-message');

    // Set icon and message
    icon.className = `toast-icon ${type}`;
    messageEl.textContent = message;

    // Show toast
    toast.classList.add('show');

    // Hide after 3 seconds
    setTimeout(() => {
        toast.classList.remove('show');
    }, 3000);
}

// Make toggleCard function globally available
window.toggleCard = toggleCard;

// Interactive Garmin Sync
function startGarminSync() {
    if (!socket) socket = io(); // Connect if not connected

    // Show Modal with Terminal
    const content = `
        <div style="display:flex; flex-direction:column; gap:10px; height: 400px;">
            <div id="garminTerminal" style="flex:1; background:#1e1e1e; color:#0f0; font-family:monospace; padding:10px; border-radius:4px; overflow-y:auto; font-size:12px; white-space:pre-wrap;">Initializing Sync...</div>
            <div id="garminInputContainer" style="display:none; gap:10px; align-items:center; background:#f3f4f6; padding:10px; border-radius:8px;">
                <label id="garminInputLabel" style="font-weight:bold; font-size:14px;">Input:</label>
                <input type="text" id="garminInputField" class="routine-text-input" style="flex:1;" onkeydown="if(event.key==='Enter') submitGarminInput()">
                <button class="btn btn-primary" onclick="submitGarminInput()">Submit</button>
            </div>
        </div>
    `;
    showModal('Garmin Sync', content);

    const term = document.getElementById('garminTerminal');
    const inputCont = document.getElementById('garminInputContainer');
    const inputField = document.getElementById('garminInputField');
    const inputLabel = document.getElementById('garminInputLabel');

    // Reset listeners to avoid duplicates
    socket.off('garmin:log');
    socket.off('garmin:prompt');
    socket.off('garmin:done');
    socket.off('garmin:error');

    // Start Sync
    socket.emit('garmin:start-sync', { userId: 1, days: 30 }); // passing dummy userID, handled by server session ideally

    socket.on('garmin:log', (msg) => {
        term.textContent += msg;
        term.scrollTop = term.scrollHeight;
    });

    socket.on('garmin:prompt', ({ field, label, type }) => {
        inputCont.style.display = 'flex';
        inputLabel.textContent = label + ':';
        inputField.type = type || 'text';
        inputField.value = '';
        inputField.focus();
        term.textContent += `\n>> Waiting for ${label}...\n`;
        term.scrollTop = term.scrollHeight;
    });

    socket.on('garmin:error', (msg) => {
        term.textContent += `\n[ERROR] ${msg}\n`;
        term.style.color = '#ef4444';
    });

    socket.on('garmin:done', ({ code }) => {
        term.textContent += `\n[Process Finished with exit code ${code}]`;
        inputCont.style.display = 'none';
        if (code === 0) {
            // Refresh everything that might have changed
            refreshFitnessCharts();
            loadRecentWorkouts();
            // Also refresh trends if the function exists
            if (typeof refreshTrendsCharts === 'function') refreshTrendsCharts();
            if (typeof loadDashboardData === 'function') loadDashboardData();
            showNotification('Sync complete! Dashboard updated.', 'success');
        }
    });

    window.submitGarminInput = function () {
        const val = inputField.value;
        if (!val) return;
        socket.emit('garmin:input', { value: val });
        inputField.value = '';
        inputCont.style.display = 'none'; // hide until next prompt
    };
}
window.startGarminSync = startGarminSync;

