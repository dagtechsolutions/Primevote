// ... previous code above unchanged ...

// Results: Grouped by position
app.get('/api/results', async (req, res) => {
  try {
    const contestants = await Contestant.find();
    if (!Array.isArray(contestants) || contestants.length === 0) {
      return res.json({});
    }
    const grouped = {};
    contestants.forEach(c => {
      if (!grouped[c.positionKey]) grouped[c.positionKey] = { label: c.positionLabel, list: [] };
      grouped[c.positionKey].list.push({
        _id: c._id, name: c.name, photo: c.photo, votes: c.votes, description: c.description
      });
    });
    res.json(grouped);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ... rest of server.js unchanged ...
