# Health Analytics Dashboard

A comprehensive health analytics dashboard web application for tracking and analyzing personal health data including sleep, activity, nutrition, mood, supplements, medications, and genetic data.

## Features

### 📊 Dashboard
- Visual metrics display with interactive charts
- Recent data entries summary
- Key health indicators (sleep score, steps, mood, heart rate)
- Real-time data visualization using Chart.js

### 📝 Data Entry Forms (Collapsible Cards)
- **Sleep Tracking**: Score, duration, deep/REM sleep, bedtime, wake time
- **Activity Monitoring**: Steps, calories, heart rate, active minutes
- **Nutrition Logging**: Calories, macros, detailed food entries
- **Mood & Stress Tracking**: 1-10 scales for mood, energy, stress, anxiety
- **Supplements Tracking**: Name, dosage, timing, notes
- **Medications Logging**: Name, dosage, frequency, dates
- **Genetic Data Upload**: CSV file upload and analysis

### 🧠 Analysis Features
- Correlation analysis between health factors
- Genetic data analysis with personalized insights
- Drug interaction checker for medications/supplements
- Pattern detection and recommendations

### 🔗 Garmin Integration
- CSV upload functionality
- Third-party API integration setup
- Automated sync capabilities
- Manual data export options

## Tech Stack

- **Backend**: Node.js with Express server
- **Database**: SQLite3 for local data storage
- **Frontend**: Vanilla HTML, CSS, and JavaScript
- **Charts**: Chart.js for data visualization
- **Styling**: Modern CSS with gradients and animations

## Installation & Setup

1. **Clone or download the project**
   ```bash
   cd "Health app analyzer"
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Populate database with sample data (optional)**
   ```bash
   node populate-sample-data.js
   ```

4. **Start the server**
   ```bash
   npm start
   ```

5. **Open your browser**
   Navigate to `http://localhost:3000`

## Usage

### Dashboard Tab
- View key health metrics and trends
- Interactive charts showing sleep, activity, mood, and nutrition data
- Recent entries summary

### Data Entry Tab
- Click on any card header to expand/collapse the form
- Use "Expand All" and "Collapse All" buttons for convenience
- Fill out forms to log your health data
- All forms include validation and error handling

### Analysis Tab
- Run correlation analysis to find relationships between health factors
- Check for drug interactions between medications and supplements
- Generate personalized recommendations based on your data

### Genetic Data Tab
- Upload CSV files containing genetic data
- View analysis results and personalized recommendations
- Sync with Garmin devices (simulated)
- Export your data for backup

## Database Schema

The application uses SQLite with the following tables:
- `sleep_data` - Sleep tracking information
- `activity_data` - Physical activity metrics
- `nutrition_data` - Daily nutrition summaries
- `food_log` - Individual food entries
- `mood_data` - Mood and stress tracking
- `supplements` - Supplement information
- `medications` - Medication tracking
- `genetic_data` - Genetic analysis results
- `correlations` - Statistical correlation data

## API Endpoints

### Data Endpoints
- `GET/POST /api/sleep` - Sleep data
- `GET/POST /api/activity` - Activity data
- `GET/POST /api/nutrition` - Nutrition data
- `GET/POST /api/food-log` - Food log entries
- `GET/POST /api/mood` - Mood data
- `GET/POST /api/supplements` - Supplements
- `GET/POST /api/medications` - Medications

### Analysis Endpoints
- `GET/POST /api/analysis/correlations` - Correlation analysis
- `GET /api/dashboard/summary` - Dashboard summary
- `POST /api/genetic-upload` - Genetic data upload

## Sample Data

The application includes comprehensive sample data for testing:
- 7 days of sleep, activity, nutrition, and mood data
- Food log entries
- Supplement and medication information
- Sample genetic data with analysis results
- Correlation analysis examples

## Features in Detail

### Collapsible Cards
- All data entry forms start collapsed
- Smooth animations for expand/collapse
- Visual indicators (▶ when collapsed, ▼ when expanded)
- Bulk controls for expanding/collapsing all cards

### Responsive Design
- Mobile-friendly interface
- Adaptive layouts for different screen sizes
- Touch-friendly controls

### Error Handling
- Client and server-side validation
- User-friendly error messages
- Loading indicators for async operations
- Toast notifications for feedback

### Data Visualization
- Interactive charts with Chart.js
- Real-time data updates
- Multiple chart types (line, bar, doughnut)
- Responsive chart sizing

## Development

### Project Structure
```
Health app analyzer/
├── server.js                 # Express server
├── package.json             # Dependencies
├── sample-data.js           # Sample data definitions
├── populate-sample-data.js  # Database population script
├── public/                  # Frontend files
│   ├── index.html          # Main HTML file
│   ├── styles.css          # CSS styles
│   └── script.js           # JavaScript functionality
└── README.md               # This file
```

### Adding New Features
1. Add database tables in `server.js` (initializeDatabase function)
2. Create API endpoints for new data types
3. Add frontend forms in `index.html`
4. Implement form handling in `script.js`
5. Add styling in `styles.css`

## Troubleshooting

### Common Issues
1. **Port already in use**: Change the PORT in `server.js` or kill the process using port 3000
2. **Database errors**: Delete `health_data.db` and restart the server
3. **Missing dependencies**: Run `npm install` again
4. **Charts not loading**: Check browser console for JavaScript errors

### Browser Compatibility
- Chrome (recommended)
- Firefox
- Safari
- Edge

## License

MIT License - feel free to use and modify for your personal health tracking needs.

## Contributing

This is a personal health tracking application. Feel free to fork and customize for your own use case.

---

**Note**: This application is for personal use and educational purposes. Always consult with healthcare professionals for medical advice.

