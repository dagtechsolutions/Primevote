const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs'); // Needed for deleting photos

const app = express();
const PORT = process.env.PORT || 4000;

// Middleware
app.use(cors());
app.use(express.json());

// Serve static files from 'public' directory (assuming index.html is in 'public')
// If your index.html is in the root, you might serve it differently or adjust paths.
// For this example, let's assume an 'uploads' folder in root and 'public' for other static assets if any.
app.use(express.static(path.join(__dirname, 'public'))); // If you have a public folder
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));


// Multer setup for photo uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const dir = 'uploads/';
    if (!fs.existsSync(dir)){
        fs.mkdirSync(dir);
    }
    cb(null, dir);
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + path.extname(file.originalname)); // Appending extension
  }
});
const upload = multer({ storage: storage, limits: { fileSize: 2 * 1024 * 1024 } });


// MongoDB connection
mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/voting', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

// Mongoose Schemas and Models
const contestantSchema = new mongoose.Schema({
  name: String,
  positionKey: String, // e.g. 'president'
  positionLabel: String, // e.g. 'President'
  photo: String, // Relative path like /uploads/filename.ext
  description: String,
  votes: { type: Number, default: 0 },
});
const Contestant = mongoose.model('Contestant', contestantSchema);

const voterSchema = new mongoose.Schema({
  voterId: { type: String, unique: true, required: true },
  votes: { type: Map, of: mongoose.Schema.Types.ObjectId }, // { positionKey: contestantId }
});
const Voter = mongoose.model('Voter', voterSchema);

const settingsSchema = new mongoose.Schema({
  votingOpen: { type: Boolean, default: false }
});
const Settings = mongoose.model('Settings', settingsSchema);


// === CONTESTANT API ===
app.post('/api/contestants', upload.single('photo'), async (req, res) => {
  try {
    const photoPath = req.file ? `/uploads/${req.file.filename}` : '';
    const { name, positionKey, positionLabel, description } = req.body;
    if (!name || !positionKey || !positionLabel || !description) {
      return res.status(400).json({ error: "All fields are required for new contestant" });
    }
    const newContestant = new Contestant({ name, positionKey, positionLabel, description, photo: photoPath });
    await newContestant.save();
    res.json(newContestant);
  } catch (error) {
    console.error("Error adding contestant:", error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/contestants', async (req, res) => {
  try {
    const contestants = await Contestant.find().sort({ positionKey: 1, name: 1 });
    res.json(contestants);
  } catch (error) {
    console.error("Error fetching contestants:", error);
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/contestants/:id', upload.single('photo'), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, positionKey, positionLabel, description } = req.body;
    if (!name || !positionKey || !positionLabel || !description) {
      return res.status(400).json({ error: "All fields are required for updating contestant" });
    }

    const contestant = await Contestant.findById(id);
    if (!contestant) return res.status(404).json({ error: "Contestant not found" });

    contestant.name = name;
    contestant.positionKey = positionKey;
    contestant.positionLabel = positionLabel;
    contestant.description = description;

    if (req.file) {
      // Delete old photo if it exists and is not a placeholder
      if (contestant.photo && contestant.photo.startsWith('/uploads/')) {
        const oldPhotoPath = path.join(__dirname, contestant.photo);
        if (fs.existsSync(oldPhotoPath)) {
          fs.unlinkSync(oldPhotoPath);
        }
      }
      contestant.photo = `/uploads/${req.file.filename}`;
    }
    // If 'removePhoto' field is sent and is true, and no new photo, clear the photo
    if (req.body.removePhoto === 'true' && !req.file) {
        if (contestant.photo && contestant.photo.startsWith('/uploads/')) {
            const oldPhotoPath = path.join(__dirname, contestant.photo);
            if (fs.existsSync(oldPhotoPath)) {
                fs.unlinkSync(oldPhotoPath);
            }
        }
        contestant.photo = ''; // Set to empty or a default placeholder path
    }


    await contestant.save();
    res.json(contestant);
  } catch (error) {
    console.error("Error updating contestant:", error);
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/contestants/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const contestant = await Contestant.findById(id);

    if (!contestant) return res.status(404).json({ error: "Contestant not found" });

    // Note: This does not automatically remove votes from voters who voted for this contestant,
    // nor does it decrement vote counts from any aggregate. This simply removes the contestant.
    // If a voter has voted for this contestant, their `voter.votes` map will still hold the (now invalid) ID.
    // Re-calculating all vote counts or cleaning up voter records would be a more complex operation.

    // Delete photo if it exists
    if (contestant.photo && contestant.photo.startsWith('/uploads/')) {
      const photoPath = path.join(__dirname, contestant.photo);
      if (fs.existsSync(photoPath)) {
        fs.unlinkSync(photoPath);
      }
    }
    await Contestant.findByIdAndDelete(id);
    res.json({ success: true, message: "Contestant deleted" });
  } catch (error) {
    console.error("Error deleting contestant:", error);
    res.status(500).json({ error: error.message });
  }
});


// === VOTER API (Admin Management) ===
app.post('/api/voters', async (req, res) => { // Bulk upload
  try {
    const ids = req.body.voterIds || [];
    if (ids.length !== 140) return res.status(400).json({ error: "Must provide exactly 140 voter IDs" });
    
    // Consider implications: This deletes all voters and their cast votes history.
    // For a system where votes need to be preserved, a different strategy for voter updates would be needed.
    await Voter.deleteMany({}); 
    
    const voterDocs = ids.map(id => ({ voterId: id, votes: new Map() }));
    await Voter.insertMany(voterDocs, { ordered: false }).catch(err => {
        // Handle potential duplicate key errors if voterId is not unique during this batch
        // For now, we assume IDs are unique within the batch.
        if (err.code === 11000) { // Duplicate key error
            console.warn("Some voter IDs might have been duplicates during bulk upload. Non-duplicates were inserted.");
            // Fall through to success, as some might have been added.
            // Or, return a specific error/warning to the client.
        } else {
            throw err; // Re-throw other errors
        }
    });
    res.json({ success: true, message: `${ids.length} voters uploaded. All previous voters cleared.` });
  } catch (error) {
    console.error("Error bulk uploading voters:", error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/admin/voters', async (req, res) => { // List voters for admin
    try {
        const voters = await Voter.find({}, 'voterId _id').sort({ voterId: 1 }); // Send only voterId and _id
        res.json(voters);
    } catch (error) {
        console.error("Error fetching voters for admin:", error);
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/admin/voters/:id', async (req, res) => { // Edit voter ID (using MongoDB _id)
    try {
        const { id } = req.params;
        const { newVoterId } = req.body;
        if (!newVoterId || String(newVoterId).trim() === '') {
            return res.status(400).json({ error: "New Voter ID cannot be empty" });
        }

        // Check if the newVoterId already exists for another voter
        const existingVoter = await Voter.findOne({ voterId: newVoterId });
        if (existingVoter && existingVoter._id.toString() !== id) {
            return res.status(409).json({ error: "This Voter ID is already in use by another voter." });
        }

        const updatedVoter = await Voter.findByIdAndUpdate(id, { voterId: newVoterId }, { new: true });
        if (!updatedVoter) {
            return res.status(404).json({ error: "Voter not found" });
        }
        res.json({ success: true, voter: { _id: updatedVoter._id, voterId: updatedVoter.voterId } });
    } catch (error) {
        console.error("Error updating voter:", error);
        if (error.code === 11000) { // Duplicate key error for voterId
            return res.status(409).json({ error: "This Voter ID is already in use." });
        }
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/admin/voters/:id', async (req, res) => { // Delete voter (using MongoDB _id)
    try {
        const { id } = req.params;
        // Note: This does not remove votes cast by this voter from Contestants.
        // If a contestant's vote count needs to be decremented, that logic would be complex:
        // 1. Find the voter.
        // 2. For each vote they cast, find the contestant and decrement their vote count.
        // This is typically not done to preserve historical accuracy of vote counts at the time of casting.
        const deletedVoter = await Voter.findByIdAndDelete(id);
        if (!deletedVoter) {
            return res.status(404).json({ error: "Voter not found" });
        }
        res.json({ success: true, message: "Voter deleted" });
    } catch (error) {
        console.error("Error deleting voter:", error);
        res.status(500).json({ error: error.message });
    }
});


// === VOTING STATE API ===
app.post('/api/voting-state', async (req, res) => {
  try {
    const { open } = req.body;
    let s = await Settings.findOne();
    if (!s) s = new Settings();
    s.votingOpen = !!open;
    await s.save();
    res.json({ votingOpen: s.votingOpen });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
app.get('/api/voting-state', async (req, res) => {
  try {
    let s = await Settings.findOne();
    res.json({ votingOpen: s ? s.votingOpen : false });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// === VOTER AUTH & VOTING ===
app.post('/api/voter-auth', async (req, res) => {
  try {
    const { voterId } = req.body;
    const voter = await Voter.findOne({ voterId });
    if (!voter) return res.status(403).json({ error: "Invalid Voter ID" });
    // Convert Map to object for JSON response
    const votesObj = voter.votes ? Object.fromEntries(voter.votes) : {};
    res.json({ votes: votesObj });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/vote', async (req, res) => {
  try {
    const { voterId, votes } = req.body; // votes: { president: contestantId, ... }
    let votingState = await Settings.findOne();
    if (!votingState || !votingState.votingOpen) return res.status(403).json({ error: "Voting is not open" });

    const voter = await Voter.findOne({ voterId });
    if (!voter) return res.status(403).json({ error: "Invalid voter" });

    let updated = false;
    const votePromises = [];

    for (const [pos, cid] of Object.entries(votes)) {
      if (!voter.votes.has(pos)) { // Only allow voting if not already voted for this position
        voter.votes.set(pos, cid);
        votePromises.push(Contestant.findByIdAndUpdate(cid, { $inc: { votes: 1 } }));
        updated = true;
      }
    }
    if (updated) {
        await Promise.all(votePromises); // Increment all contestant votes
        await voter.save(); // Save voter's choices
    }
    const votesObj = voter.votes ? Object.fromEntries(voter.votes) : {};
    res.json({ success: true, votes: votesObj });
  } catch (error)
{
    console.error("Error submitting vote:", error);
    res.status(500).json({ error: error.message });
  }
});

// === RESULTS API ===
app.get('/api/results', async (req, res) => {
  try {
    const contestants = await Contestant.find().sort({positionKey: 1, name: 1});
    if (!Array.isArray(contestants)) { // No need for length check if it's not an array
      return res.json({});
    }
    const grouped = {};
    contestants.forEach(c => {
      if (!grouped[c.positionKey]) grouped[c.positionKey] = { label: c.positionLabel, list: [] };
      grouped[c.positionKey].list.push({
        _id: c._id.toString(), name: c.name, photo: c.photo, votes: c.votes, description: c.description
      });
    });
    res.json(grouped);
  } catch (error) {
    console.error("Error fetching results:", error);
    res.status(500).json({ error: error.message });
  }
});

// Root route (serve index.html from public if it exists)
app.get('/', (req, res) => {
  // This assumes your index.html is in a 'public' folder.
  // If index.html is in the root with server.js, use:
  // res.sendFile(path.join(__dirname, 'index.html'));
  // For now, sticking to the original 'public' folder convention.
  const indexPath = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    // If you want to serve the uploaded index.html directly (if not in public)
    res.sendFile(path.join(__dirname, 'index.html'));
    // However, it's better practice to have a dedicated 'public' or 'client/build' folder.
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Backend running at http://localhost:${PORT}`);
});
