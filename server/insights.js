function isoDate(d) {
  return d.toISOString().split('T')[0];
}

function parseIsoDate(s) {
  const d = new Date(String(s));
  return Number.isNaN(d.getTime()) ? null : d;
}

function startOfWeekMonday(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay(); // 0 Sun ... 6 Sat
  const diff = (day === 0 ? -6 : 1) - day;
  d.setDate(d.getDate() + diff);
  return d;
}

async function computeWeekRollup({ userId, weekStart, allDb, getDb }) {
  const ws = new Date(weekStart);
  ws.setHours(0, 0, 0, 0);
  const we = new Date(ws);
  we.setDate(we.getDate() + 7);

  const wsIso = isoDate(ws);
  const weIso = isoDate(we);

  const nutrition = await allDb(
    `SELECT date, calories, protein_g, carbs_g, fat_g
       FROM nutrition_data
      WHERE user_id = ? AND date >= ? AND date < ?
   ORDER BY date ASC`,
    [userId, wsIso, weIso]
  );

  const workouts = await allDb(
    `SELECT date, type, duration_minutes, distance_km, calories
       FROM workout_sessions
      WHERE user_id = ? AND date >= ? AND date < ?
   ORDER BY date ASC`,
    [userId, wsIso, weIso]
  );

  const body = await allDb(
    `SELECT date, weight_kg, body_fat_pct
       FROM body_composition
      WHERE user_id = ? AND date >= ? AND date < ?
   ORDER BY date ASC`,
    [userId, wsIso, weIso]
  );

  const checkins = await allDb(
    `SELECT occurred_at, mood_score, stress_score, energy_score, anxiety_score
       FROM mood_checkins
      WHERE user_id = ? AND occurred_at >= ? AND occurred_at < ?
   ORDER BY occurred_at ASC`,
    [userId, ws.toISOString(), we.toISOString()]
  );

  const hr = await allDb(
    `SELECT start_at, value_num
       FROM biometric_samples
      WHERE user_id = ? AND type IN ('heart_rate','hr')
        AND start_at >= ? AND start_at < ?`,
    [userId, ws.toISOString(), we.toISOString()]
  );

  const journalEvents = await allDb(
    `SELECT occurred_at, extracted_json
       FROM insight_events
      WHERE user_id = ? AND kind = 'journal_extraction'
        AND occurred_at >= ? AND occurred_at < ?
   ORDER BY occurred_at ASC`,
    [userId, ws.toISOString(), we.toISOString()]
  );

  const totalCalories = nutrition.reduce((s, r) => s + (Number(r.calories) || 0), 0);
  const macro = {
    protein_g: nutrition.reduce((s, r) => s + (Number(r.protein_g) || 0), 0),
    carbs_g: nutrition.reduce((s, r) => s + (Number(r.carbs_g) || 0), 0),
    fat_g: nutrition.reduce((s, r) => s + (Number(r.fat_g) || 0), 0)
  };

  const runs = workouts.filter(w => w.type === 'run');
  const strength = workouts.filter(w => w.type === 'strength');
  const totalWorkoutMinutes = workouts.reduce((s, r) => s + (Number(r.duration_minutes) || 0), 0);
  const totalRunKm = runs.reduce((s, r) => s + (Number(r.distance_km) || 0), 0);

  const weightStart = body.length ? body[0].weight_kg : null;
  const weightEnd = body.length ? body[body.length - 1].weight_kg : null;
  const weightDelta = (weightStart != null && weightEnd != null) ? (Number(weightEnd) - Number(weightStart)) : null;

  const avg = (arr, key) => {
    const vals = arr.map(x => Number(x[key])).filter(n => Number.isFinite(n));
    if (!vals.length) return null;
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  };

  const avgStress = avg(checkins, 'stress_score');
  const avgMood = avg(checkins, 'mood_score');
  const avgEnergy = avg(checkins, 'energy_score');
  const avgHr = (() => {
    const vals = hr.map(x => Number(x.value_num)).filter(n => Number.isFinite(n));
    if (!vals.length) return null;
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  })();

  // Count negative emotion mentions from journal extraction
  let negativeEmotionCount = 0;
  let topEventCategories = {};
  for (const e of journalEvents) {
    try {
      const j = e.extracted_json ? JSON.parse(e.extracted_json) : null;
      const emotions = Array.isArray(j?.emotions) ? j.emotions : [];
      emotions.forEach(em => {
        const label = String(em?.label || '').toLowerCase();
        if (['anger','sadness','anxiety','stress','frustration','fear','guilt','shame'].includes(label)) negativeEmotionCount++;
      });
      const events = Array.isArray(j?.events) ? j.events : [];
      events.forEach(ev => {
        const cat = String(ev?.category || 'other');
        topEventCategories[cat] = (topEventCategories[cat] || 0) + 1;
      });
    } catch {}
  }

  const topCats = Object.entries(topEventCategories).sort((a, b) => b[1] - a[1]).slice(0, 4).map(x => x[0]);

  return {
    week_start: wsIso,
    week_end: isoDate(new Date(we.getTime() - 1)),
    totals: {
      calories: totalCalories,
      macros_g: macro,
      workouts: {
        count: workouts.length,
        minutes: totalWorkoutMinutes,
        runs: { count: runs.length, km: totalRunKm },
        strength: { count: strength.length }
      },
      body: {
        weighins: body.length,
        weight_start_kg: weightStart,
        weight_end_kg: weightEnd,
        weight_delta_kg: weightDelta
      },
      checkins: {
        count: checkins.length,
        avg_mood: avgMood,
        avg_stress: avgStress,
        avg_energy: avgEnergy
      },
      biometrics: {
        avg_heart_rate: avgHr
      },
      journal: {
        extractions: journalEvents.length,
        negative_emotion_mentions: negativeEmotionCount,
        top_event_categories: topCats
      }
    }
  };
}

module.exports = {
  startOfWeekMonday,
  parseIsoDate,
  isoDate,
  computeWeekRollup
};

