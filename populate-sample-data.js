const sqlite3 = require('sqlite3').verbose();
const sampleData = require('./sample-data');

// Initialize database connection
const db = new sqlite3.Database('health_data.db', (err) => {
    if (err) {
        console.error('Error opening database:', err.message);
        process.exit(1);
    } else {
        console.log('Connected to SQLite database');
        populateData();
    }
});

function populateData() {
    console.log('Starting to populate database with sample data...');
    
    // Clear existing data
    const clearQueries = [
        'DELETE FROM sleep_data',
        'DELETE FROM activity_data',
        'DELETE FROM nutrition_data',
        'DELETE FROM food_log',
        'DELETE FROM mood_data',
        'DELETE FROM supplements',
        'DELETE FROM medications',
        'DELETE FROM genetic_data',
        'DELETE FROM correlations'
    ];
    
    let cleared = 0;
    clearQueries.forEach(query => {
        db.run(query, (err) => {
            if (err) {
                console.error('Error clearing data:', err.message);
            } else {
                cleared++;
                if (cleared === clearQueries.length) {
                    insertSampleData();
                }
            }
        });
    });
}

function insertSampleData() {
    let completed = 0;
    const totalOperations = 7; // Number of data types to insert
    
    // Insert sleep data
    const sleepStmt = db.prepare('INSERT INTO sleep_data (date, score, duration_hours, deep_sleep_hours, rem_sleep_hours, bedtime, wake_time) VALUES (?, ?, ?, ?, ?, ?, ?)');
    sampleData.sleep.forEach(item => {
        sleepStmt.run([item.date, item.score, item.duration_hours, item.deep_sleep_hours, item.rem_sleep_hours, item.bedtime, item.wake_time]);
    });
    sleepStmt.finalize();
    completed++;
    console.log('✓ Sleep data inserted');
    
    // Insert activity data
    const activityStmt = db.prepare('INSERT INTO activity_data (date, steps, calories_burned, heart_rate_avg, active_minutes) VALUES (?, ?, ?, ?, ?)');
    sampleData.activity.forEach(item => {
        activityStmt.run([item.date, item.steps, item.calories_burned, item.heart_rate_avg, item.active_minutes]);
    });
    activityStmt.finalize();
    completed++;
    console.log('✓ Activity data inserted');
    
    // Insert nutrition data
    const nutritionStmt = db.prepare('INSERT INTO nutrition_data (date, calories, protein_g, carbs_g, fat_g, fiber_g, sugar_g) VALUES (?, ?, ?, ?, ?, ?, ?)');
    sampleData.nutrition.forEach(item => {
        nutritionStmt.run([item.date, item.calories, item.protein_g, item.carbs_g, item.fat_g, item.fiber_g, item.sugar_g]);
    });
    nutritionStmt.finalize();
    completed++;
    console.log('✓ Nutrition data inserted');
    
    // Insert food log data
    const foodLogStmt = db.prepare('INSERT INTO food_log (date, food_name, calories, protein_g, carbs_g, fat_g, serving_size) VALUES (?, ?, ?, ?, ?, ?, ?)');
    sampleData.foodLog.forEach(item => {
        foodLogStmt.run([item.date, item.food_name, item.calories, item.protein_g, item.carbs_g, item.fat_g, item.serving_size]);
    });
    foodLogStmt.finalize();
    completed++;
    console.log('✓ Food log data inserted');
    
    // Insert mood data
    const moodStmt = db.prepare('INSERT INTO mood_data (date, mood_score, energy_score, stress_score, anxiety_score, notes) VALUES (?, ?, ?, ?, ?, ?)');
    sampleData.mood.forEach(item => {
        moodStmt.run([item.date, item.mood_score, item.energy_score, item.stress_score, item.anxiety_score, item.notes]);
    });
    moodStmt.finalize();
    completed++;
    console.log('✓ Mood data inserted');
    
    // Insert supplements data
    const supplementsStmt = db.prepare('INSERT INTO supplements (name, dosage, timing, notes, start_date, end_date) VALUES (?, ?, ?, ?, ?, ?)');
    sampleData.supplements.forEach(item => {
        supplementsStmt.run([item.name, item.dosage, item.timing, item.notes, item.start_date, item.end_date]);
    });
    supplementsStmt.finalize();
    completed++;
    console.log('✓ Supplements data inserted');
    
    // Insert medications data
    const medicationsStmt = db.prepare('INSERT INTO medications (name, dosage, frequency, start_date, end_date, notes) VALUES (?, ?, ?, ?, ?, ?)');
    sampleData.medications.forEach(item => {
        medicationsStmt.run([item.name, item.dosage, item.frequency, item.start_date, item.end_date, item.notes]);
    });
    medicationsStmt.finalize();
    completed++;
    console.log('✓ Medications data inserted');
    
    // Insert genetic data
    const geneticStmt = db.prepare('INSERT INTO genetic_data (filename, data, analysis_results) VALUES (?, ?, ?)');
    geneticStmt.run([
        sampleData.geneticData.filename,
        sampleData.geneticData.data,
        JSON.stringify(sampleData.geneticData.analysis_results)
    ]);
    geneticStmt.finalize();
    completed++;
    console.log('✓ Genetic data inserted');
    
    // Insert sample correlations
    const correlationsStmt = db.prepare('INSERT INTO correlations (factor1, factor2, correlation_coefficient, p_value, sample_size) VALUES (?, ?, ?, ?, ?)');
    const sampleCorrelations = [
        ['Sleep Score', 'Mood Score', 0.72, 0.001, 7],
        ['Steps', 'Energy Score', 0.58, 0.02, 7],
        ['Sleep Duration', 'Stress Score', -0.45, 0.05, 7],
        ['Protein Intake', 'Energy Score', 0.35, 0.08, 7]
    ];
    
    sampleCorrelations.forEach(corr => {
        correlationsStmt.run(corr);
    });
    correlationsStmt.finalize();
    completed++;
    console.log('✓ Sample correlations inserted');
    
    if (completed === totalOperations + 1) { // +1 for correlations
        console.log('\n🎉 Database populated successfully with sample data!');
        console.log('\nSample data includes:');
        console.log('- 7 days of sleep tracking data');
        console.log('- 7 days of activity monitoring data');
        console.log('- 7 days of nutrition logging data');
        console.log('- 5 food log entries');
        console.log('- 7 days of mood & stress tracking');
        console.log('- 4 supplement entries');
        console.log('- 2 medication entries');
        console.log('- Sample genetic data with analysis');
        console.log('- Sample correlation analysis results');
        console.log('\nYou can now start the server and explore the dashboard!');
        
        db.close((err) => {
            if (err) {
                console.error('Error closing database:', err.message);
            } else {
                console.log('Database connection closed.');
                process.exit(0);
            }
        });
    }
}

