// Sample data for testing the health analytics dashboard
const sampleData = {
    sleep: [
        {
            date: '2024-01-15',
            score: 8,
            duration_hours: 7.5,
            deep_sleep_hours: 2.1,
            rem_sleep_hours: 1.8,
            bedtime: '22:30',
            wake_time: '06:00'
        },
        {
            date: '2024-01-14',
            score: 7,
            duration_hours: 6.8,
            deep_sleep_hours: 1.9,
            rem_sleep_hours: 1.6,
            bedtime: '23:15',
            wake_time: '06:00'
        },
        {
            date: '2024-01-13',
            score: 9,
            duration_hours: 8.2,
            deep_sleep_hours: 2.3,
            rem_sleep_hours: 2.0,
            bedtime: '22:00',
            wake_time: '06:15'
        },
        {
            date: '2024-01-12',
            score: 6,
            duration_hours: 6.2,
            deep_sleep_hours: 1.5,
            rem_sleep_hours: 1.3,
            bedtime: '23:45',
            wake_time: '06:00'
        },
        {
            date: '2024-01-11',
            score: 8,
            duration_hours: 7.8,
            deep_sleep_hours: 2.2,
            rem_sleep_hours: 1.9,
            bedtime: '22:15',
            wake_time: '06:00'
        },
        {
            date: '2024-01-10',
            score: 7,
            duration_hours: 7.0,
            deep_sleep_hours: 1.8,
            rem_sleep_hours: 1.7,
            bedtime: '22:45',
            wake_time: '05:45'
        },
        {
            date: '2024-01-09',
            score: 8,
            duration_hours: 7.3,
            deep_sleep_hours: 2.0,
            rem_sleep_hours: 1.8,
            bedtime: '22:30',
            wake_time: '06:00'
        }
    ],
    
    activity: [
        {
            date: '2024-01-15',
            steps: 12500,
            calories_burned: 2400,
            heart_rate_avg: 72,
            active_minutes: 45
        },
        {
            date: '2024-01-14',
            steps: 9800,
            calories_burned: 2100,
            heart_rate_avg: 68,
            active_minutes: 35
        },
        {
            date: '2024-01-13',
            steps: 15200,
            calories_burned: 2800,
            heart_rate_avg: 75,
            active_minutes: 60
        },
        {
            date: '2024-01-12',
            steps: 8500,
            calories_burned: 1900,
            heart_rate_avg: 65,
            active_minutes: 25
        },
        {
            date: '2024-01-11',
            steps: 11800,
            calories_burned: 2300,
            heart_rate_avg: 70,
            active_minutes: 40
        },
        {
            date: '2024-01-10',
            steps: 13200,
            calories_burned: 2500,
            heart_rate_avg: 73,
            active_minutes: 50
        },
        {
            date: '2024-01-09',
            steps: 10500,
            calories_burned: 2200,
            heart_rate_avg: 69,
            active_minutes: 38
        }
    ],
    
    nutrition: [
        {
            date: '2024-01-15',
            calories: 2200,
            protein_g: 120,
            carbs_g: 280,
            fat_g: 85,
            fiber_g: 35,
            sugar_g: 45
        },
        {
            date: '2024-01-14',
            calories: 1950,
            protein_g: 110,
            carbs_g: 240,
            fat_g: 75,
            fiber_g: 30,
            sugar_g: 40
        },
        {
            date: '2024-01-13',
            calories: 2500,
            protein_g: 140,
            carbs_g: 320,
            fat_g: 95,
            fiber_g: 40,
            sugar_g: 50
        },
        {
            date: '2024-01-12',
            calories: 1800,
            protein_g: 95,
            carbs_g: 220,
            fat_g: 65,
            fiber_g: 25,
            sugar_g: 35
        },
        {
            date: '2024-01-11',
            calories: 2100,
            protein_g: 125,
            carbs_g: 260,
            fat_g: 80,
            fiber_g: 32,
            sugar_g: 42
        },
        {
            date: '2024-01-10',
            calories: 2300,
            protein_g: 130,
            carbs_g: 290,
            fat_g: 90,
            fiber_g: 38,
            sugar_g: 48
        },
        {
            date: '2024-01-09',
            calories: 2050,
            protein_g: 115,
            carbs_g: 250,
            fat_g: 78,
            fiber_g: 28,
            sugar_g: 38
        }
    ],
    
    mood: [
        {
            date: '2024-01-15',
            mood_score: 8,
            energy_score: 7,
            stress_score: 3,
            anxiety_score: 2,
            notes: 'Great day, feeling energetic and positive'
        },
        {
            date: '2024-01-14',
            mood_score: 6,
            energy_score: 5,
            stress_score: 6,
            anxiety_score: 4,
            notes: 'Tired from work, some stress but manageable'
        },
        {
            date: '2024-01-13',
            mood_score: 9,
            energy_score: 8,
            stress_score: 2,
            anxiety_score: 1,
            notes: 'Excellent day, very relaxed and happy'
        },
        {
            date: '2024-01-12',
            mood_score: 5,
            energy_score: 4,
            stress_score: 7,
            anxiety_score: 6,
            notes: 'Difficult day, high stress levels'
        },
        {
            date: '2024-01-11',
            mood_score: 7,
            energy_score: 6,
            stress_score: 4,
            anxiety_score: 3,
            notes: 'Good day overall, moderate energy'
        },
        {
            date: '2024-01-10',
            mood_score: 8,
            energy_score: 7,
            stress_score: 3,
            anxiety_score: 2,
            notes: 'Feeling good, productive day'
        },
        {
            date: '2024-01-09',
            mood_score: 6,
            energy_score: 5,
            stress_score: 5,
            anxiety_score: 4,
            notes: 'Average day, some fatigue'
        }
    ],
    
    foodLog: [
        {
            date: '2024-01-15',
            food_name: 'Grilled Chicken Breast',
            calories: 250,
            protein_g: 35,
            carbs_g: 0,
            fat_g: 8,
            serving_size: '150g'
        },
        {
            date: '2024-01-15',
            food_name: 'Brown Rice',
            calories: 220,
            protein_g: 5,
            carbs_g: 45,
            fat_g: 2,
            serving_size: '1 cup'
        },
        {
            date: '2024-01-15',
            food_name: 'Mixed Vegetables',
            calories: 80,
            protein_g: 3,
            carbs_g: 15,
            fat_g: 1,
            serving_size: '1 cup'
        },
        {
            date: '2024-01-14',
            food_name: 'Salmon Fillet',
            calories: 300,
            protein_g: 40,
            carbs_g: 0,
            fat_g: 15,
            serving_size: '180g'
        },
        {
            date: '2024-01-14',
            food_name: 'Quinoa',
            calories: 200,
            protein_g: 8,
            carbs_g: 35,
            fat_g: 3,
            serving_size: '1 cup'
        }
    ],
    
    supplements: [
        {
            name: 'Vitamin D3',
            dosage: '2000 IU',
            timing: 'Morning with breakfast',
            notes: 'For bone health and immune support',
            start_date: '2024-01-01',
            end_date: null
        },
        {
            name: 'Omega-3 Fish Oil',
            dosage: '1000mg',
            timing: 'Evening with dinner',
            notes: 'For cardiovascular health',
            start_date: '2024-01-01',
            end_date: null
        },
        {
            name: 'Magnesium',
            dosage: '400mg',
            timing: 'Before bed',
            notes: 'For better sleep quality',
            start_date: '2024-01-01',
            end_date: null
        },
        {
            name: 'Probiotics',
            dosage: '50 billion CFU',
            timing: 'Morning on empty stomach',
            notes: 'For gut health',
            start_date: '2024-01-01',
            end_date: null
        }
    ],
    
    medications: [
        {
            name: 'Multivitamin',
            dosage: '1 tablet',
            frequency: 'Once daily',
            start_date: '2024-01-01',
            end_date: null,
            notes: 'General health maintenance'
        },
        {
            name: 'Iron Supplement',
            dosage: '18mg',
            frequency: 'Once daily',
            start_date: '2024-01-01',
            end_date: '2024-03-01',
            notes: 'For iron deficiency, take with vitamin C'
        }
    ],
    
    geneticData: {
        filename: 'sample_genetic_data.csv',
        data: `rsid,chromosome,position,genotype
rs429358,19,45411941,CT
rs7412,19,45412079,CC
rs1801133,1,11796321,GG
rs1801131,1,11796322,AA
rs429358,19,45411941,CT
rs7412,19,45412079,CC
rs1801133,1,11796321,GG
rs1801131,1,11796322,AA
rs429358,19,45411941,CT
rs7412,19,45412079,CC
rs1801133,1,11796321,GG
rs1801131,1,11796322,AA`,
        analysis_results: {
            totalSNPs: 12,
            analysisDate: '2024-01-15T10:30:00Z',
            recommendations: [
                'Consider vitamin D supplementation based on VDR gene variants',
                'Monitor caffeine sensitivity based on CYP1A2 variants',
                'Consider omega-3 supplementation for cardiovascular health',
                'Regular exercise recommended based on fitness-related genes'
            ],
            riskFactors: [
                'Slightly increased risk for type 2 diabetes',
                'Normal cardiovascular risk profile',
                'Low risk for Alzheimer\'s disease',
                'Moderate risk for osteoporosis'
            ]
        }
    }
};

module.exports = sampleData;

