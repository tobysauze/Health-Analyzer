const fs = require('fs');
const xml2js = require('xml2js');
const csv = require('csv-parser');
const XLSX = require('xlsx');
const path = require('path');

/**
 * Parse Garmin data files and extract health metrics
 * Supports: CSV, TCX, GPX, Excel files from Garmin Connect
 */
class GarminParser {
  constructor() {
    this.parsedData = {
      activities: [],
      sleep: [],
      bodyComposition: [],
      stress: [],
      heartRate: []
    };
  }

  /**
   * Main parsing function - determines file type and routes to appropriate parser
   */
  async parseFile(filePath, filename) {
    const fileExtension = path.extname(filename).toLowerCase();
    
    try {
      if (fileExtension === '.csv') {
        return await this.parseCSV(filePath);
      } else if (fileExtension === '.tcx') {
        return await this.parseTCX(filePath);
      } else if (fileExtension === '.gpx') {
        return await this.parseGPX(filePath);
      } else if (fileExtension === '.xlsx' || fileExtension === '.xls') {
        return await this.parseExcel(filePath);
      } else {
        throw new Error(`Unsupported file format: ${fileExtension}`);
      }
    } catch (error) {
      throw new Error(`Error parsing Garmin file: ${error.message}`);
    }
  }

  /**
   * Parse CSV files from Garmin Connect
   */
  async parseCSV(filePath) {
    return new Promise((resolve, reject) => {
      const results = {
        activities: [],
        sleep: [],
        bodyComposition: [],
        stress: [],
        heartRate: []
      };

      const stream = fs.createReadStream(filePath);
      
      stream.pipe(csv())
        .on('data', (row) => {
          // Detect what type of data this is based on column names
          const columns = Object.keys(row);
          
          // Activity data (steps, calories, distance, etc.)
          if (columns.some(col => col.toLowerCase().includes('step') || 
                               col.toLowerCase().includes('calorie') ||
                               col.toLowerCase().includes('distance'))) {
            results.activities.push(this.parseActivityRow(row));
          }
          
          // Sleep data
          if (columns.some(col => col.toLowerCase().includes('sleep') || 
                               col.toLowerCase().includes('bedtime') ||
                               col.toLowerCase().includes('wake'))) {
            results.sleep.push(this.parseSleepRow(row));
          }
          
          // Heart rate data
          if (columns.some(col => col.toLowerCase().includes('heart') || 
                               col.toLowerCase().includes('hr'))) {
            results.heartRate.push(this.parseHeartRateRow(row));
          }
          
          // Stress data
          if (columns.some(col => col.toLowerCase().includes('stress'))) {
            results.stress.push(this.parseStressRow(row));
          }
        })
        .on('end', () => {
          resolve(results);
        })
        .on('error', (error) => {
          reject(error);
        });
    });
  }

  /**
   * Parse TCX (Training Center XML) files
   */
  async parseTCX(filePath) {
    const parser = new xml2js.Parser();
    const xmlData = fs.readFileSync(filePath, 'utf8');
    
    return new Promise((resolve, reject) => {
      parser.parseString(xmlData, (err, result) => {
        if (err) {
          reject(err);
          return;
        }

        const activities = [];
        
        // Extract activities from TCX
        if (result.TrainingCenterDatabase && result.TrainingCenterDatabase.Activities) {
          const activityList = result.TrainingCenterDatabase.Activities[0].Activity || [];
          
          activityList.forEach(activity => {
            const activityData = this.parseTCXActivity(activity);
            if (activityData) {
              activities.push(activityData);
            }
          });
        }

        resolve({
          activities: activities,
          sleep: [],
          bodyComposition: [],
          stress: [],
          heartRate: []
        });
      });
    });
  }

  /**
   * Parse GPX files
   */
  async parseGPX(filePath) {
    const parser = new xml2js.Parser();
    const xmlData = fs.readFileSync(filePath, 'utf8');
    
    return new Promise((resolve, reject) => {
      parser.parseString(xmlData, (err, result) => {
        if (err) {
          reject(err);
          return;
        }

        const activities = [];
        
        // Extract track data from GPX
        if (result.gpx && result.gpx.trk) {
          const tracks = Array.isArray(result.gpx.trk) ? result.gpx.trk : [result.gpx.trk];
          
          tracks.forEach(track => {
            const activityData = this.parseGPXTrack(track);
            if (activityData) {
              activities.push(activityData);
            }
          });
        }

        resolve({
          activities: activities,
          sleep: [],
          bodyComposition: [],
          stress: [],
          heartRate: []
        });
      });
    });
  }

  /**
   * Parse Excel files
   */
  async parseExcel(filePath) {
    const workbook = XLSX.readFile(filePath);
    const results = {
      activities: [],
      sleep: [],
      bodyComposition: [],
      stress: [],
      heartRate: []
    };

    // Process each sheet
    workbook.SheetNames.forEach(sheetName => {
      const worksheet = workbook.Sheets[sheetName];
      const jsonData = XLSX.utils.sheet_to_json(worksheet);
      
      jsonData.forEach(row => {
        const columns = Object.keys(row);
        
        // Detect data type and parse
        if (columns.some(col => col.toLowerCase().includes('step') || 
                           col.toLowerCase().includes('calorie'))) {
          results.activities.push(this.parseActivityRow(row));
        } else if (columns.some(col => col.toLowerCase().includes('sleep'))) {
          results.sleep.push(this.parseSleepRow(row));
        } else if (columns.some(col => col.toLowerCase().includes('heart'))) {
          results.heartRate.push(this.parseHeartRateRow(row));
        }
      });
    });

    return results;
  }

  /**
   * Parse activity row from CSV/Excel
   */
  parseActivityRow(row) {
    const date = this.extractDate(row);
    const steps = this.extractNumber(row, ['steps', 'step count', 'total steps']);
    const calories = this.extractNumber(row, ['calories', 'calories burned', 'total calories', 'cal']);
    const distance = this.extractNumber(row, ['distance', 'total distance', 'dist']);
    const activeMinutes = this.extractNumber(row, ['active minutes', 'minutes active', 'activity minutes']);
    const heartRate = this.extractNumber(row, ['heart rate', 'avg heart rate', 'average hr', 'hr']);
    
    return {
      date: date,
      steps: steps,
      calories_burned: calories,
      distance: distance,
      active_minutes: activeMinutes,
      heart_rate_avg: heartRate
    };
  }

  /**
   * Parse sleep row from CSV/Excel
   */
  parseSleepRow(row) {
    const date = this.extractDate(row);
    const duration = this.extractNumber(row, ['sleep duration', 'total sleep', 'duration', 'hours']);
    const deepSleep = this.extractNumber(row, ['deep sleep', 'deep', 'deep sleep hours']);
    const remSleep = this.extractNumber(row, ['rem sleep', 'rem', 'rem sleep hours']);
    const bedtime = this.extractTime(row, ['bedtime', 'sleep start', 'start time']);
    const wakeTime = this.extractTime(row, ['wake time', 'wake', 'end time']);
    const score = this.extractNumber(row, ['sleep score', 'score', 'quality score']);
    
    return {
      date: date,
      score: score || this.calculateSleepScore(duration),
      duration_hours: duration,
      deep_sleep_hours: deepSleep,
      rem_sleep_hours: remSleep,
      bedtime: bedtime,
      wake_time: wakeTime
    };
  }

  /**
   * Parse heart rate row
   */
  parseHeartRateRow(row) {
    const date = this.extractDate(row);
    const heartRate = this.extractNumber(row, ['heart rate', 'hr', 'avg heart rate', 'average hr']);
    
    return {
      date: date,
      heart_rate_avg: heartRate
    };
  }

  /**
   * Parse stress row
   */
  parseStressRow(row) {
    const date = this.extractDate(row);
    const stress = this.extractNumber(row, ['stress', 'stress level', 'stress score']);
    
    return {
      date: date,
      stress_score: stress ? Math.min(10, Math.max(1, Math.round(stress))) : null
    };
  }

  /**
   * Parse TCX activity
   */
  parseTCXActivity(activity) {
    try {
      const id = activity.Id ? activity.Id[0] : null;
      const sport = activity.Sport ? activity.Sport[0].$.Sport : 'Running';
      
      // Extract date from ID or start time
      let date = null;
      if (id) {
        date = this.parseDateFromString(id);
      }
      
      // Extract lap data
      let totalDistance = 0;
      let totalCalories = 0;
      let avgHeartRate = null;
      let maxHeartRate = null;
      
      if (activity.Lap) {
        activity.Lap.forEach(lap => {
          if (lap.DistanceMeters) {
            totalDistance += parseFloat(lap.DistanceMeters[0]) || 0;
          }
          if (lap.Calories) {
            totalCalories += parseInt(lap.Calories[0]) || 0;
          }
          if (lap.AverageHeartRateBpm) {
            avgHeartRate = parseInt(lap.AverageHeartRateBpm[0].Value[0]) || null;
          }
          if (lap.MaximumHeartRateBpm) {
            maxHeartRate = parseInt(lap.MaximumHeartRateBpm[0].Value[0]) || null;
          }
        });
      }
      
      // Estimate steps (rough calculation: ~2000 steps per mile)
      const steps = totalDistance > 0 ? Math.round((totalDistance / 1609.34) * 2000) : null;
      
      return {
        date: date || new Date().toISOString().split('T')[0],
        steps: steps,
        calories_burned: totalCalories || null,
        distance: totalDistance > 0 ? (totalDistance / 1000).toFixed(2) : null, // Convert to km
        active_minutes: null, // TCX doesn't always have this
        heart_rate_avg: avgHeartRate
      };
    } catch (error) {
      console.error('Error parsing TCX activity:', error);
      return null;
    }
  }

  /**
   * Parse GPX track
   */
  parseGPXTrack(track) {
    try {
      const name = track.name ? track.name[0] : 'Activity';
      const date = track.time ? this.parseDateFromString(track.time[0]) : new Date().toISOString().split('T')[0];
      
      // Calculate distance from track points
      let totalDistance = 0;
      if (track.trkseg && track.trkseg[0] && track.trkseg[0].trkpt) {
        const points = track.trkseg[0].trkpt;
        for (let i = 1; i < points.length; i++) {
          const lat1 = parseFloat(points[i-1].$.lat);
          const lon1 = parseFloat(points[i-1].$.lon);
          const lat2 = parseFloat(points[i].$.lat);
          const lon2 = parseFloat(points[i].$.lon);
          
          totalDistance += this.calculateDistance(lat1, lon1, lat2, lon2);
        }
      }
      
      // Estimate steps
      const steps = totalDistance > 0 ? Math.round((totalDistance / 1609.34) * 2000) : null;
      
      return {
        date: date,
        steps: steps,
        calories_burned: null,
        distance: totalDistance > 0 ? totalDistance.toFixed(2) : null,
        active_minutes: null,
        heart_rate_avg: null
      };
    } catch (error) {
      console.error('Error parsing GPX track:', error);
      return null;
    }
  }

  // Helper functions
  extractDate(row) {
    for (const key of Object.keys(row)) {
      const lowerKey = key.toLowerCase();
      if (lowerKey.includes('date') || lowerKey.includes('time')) {
        const dateStr = row[key];
        if (dateStr) {
          const parsed = this.parseDateFromString(dateStr);
          if (parsed) return parsed;
        }
      }
    }
    return new Date().toISOString().split('T')[0];
  }

  extractNumber(row, possibleKeys) {
    for (const key of Object.keys(row)) {
      const lowerKey = key.toLowerCase();
      if (possibleKeys.some(pk => lowerKey.includes(pk.toLowerCase()))) {
        const value = row[key];
        if (value !== null && value !== undefined && value !== '') {
          const num = parseFloat(value);
          if (!isNaN(num)) return Math.round(num);
        }
      }
    }
    return null;
  }

  extractTime(row, possibleKeys) {
    for (const key of Object.keys(row)) {
      const lowerKey = key.toLowerCase();
      if (possibleKeys.some(pk => lowerKey.includes(pk.toLowerCase()))) {
        const value = row[key];
        if (value) {
          // Try to extract time in HH:MM format
          const timeMatch = value.toString().match(/(\d{1,2}):(\d{2})/);
          if (timeMatch) {
            return timeMatch[0];
          }
        }
      }
    }
    return null;
  }

  parseDateFromString(dateStr) {
    if (!dateStr) return null;
    
    try {
      const date = new Date(dateStr);
      if (!isNaN(date.getTime())) {
        return date.toISOString().split('T')[0];
      }
    } catch (e) {
      // Try other formats
    }
    
    // Try common date formats
    const formats = [
      /(\d{4})-(\d{2})-(\d{2})/,  // YYYY-MM-DD
      /(\d{2})\/(\d{2})\/(\d{4})/, // MM/DD/YYYY
      /(\d{2})-(\d{2})-(\d{4})/    // MM-DD-YYYY
    ];
    
    for (const format of formats) {
      const match = dateStr.toString().match(format);
      if (match) {
        if (format === formats[0]) {
          return match[0];
        } else {
          const [, m, d, y] = match;
          return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
        }
      }
    }
    
    return null;
  }

  calculateSleepScore(duration) {
    if (!duration) return null;
    // Simple scoring: 7-9 hours = 8-10, 6-7 = 6-7, <6 = 4-5, >9 = 7-8
    if (duration >= 7 && duration <= 9) return 8;
    if (duration >= 6 && duration < 7) return 6;
    if (duration < 6) return 4;
    if (duration > 9) return 7;
    return 5;
  }

  calculateDistance(lat1, lon1, lat2, lon2) {
    // Haversine formula for distance calculation
    const R = 6371; // Earth's radius in km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
  }
}

module.exports = GarminParser;



