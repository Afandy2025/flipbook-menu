const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 8080;

// Ensure uploads directory exists
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Multer storage: save with unique ID
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
        const id = crypto.randomBytes(6).toString('hex'); // 12-char hex ID
        cb(null, id + '.pdf');
    }
});
const upload = multer({
    storage,
    limits: { fileSize: 100 * 1024 * 1024 }, // 100MB max
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/pdf') cb(null, true);
        else cb(new Error('Only PDF files are allowed'));
    }
});

// ─── API: Upload PDF ───
app.post('/api/upload', upload.single('pdf'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const id = path.basename(req.file.filename, '.pdf');
    res.json({ id, url: '/view/' + id });
});

// ─── API: Get PDF by ID ───
app.get('/api/pdf/:id', (req, res) => {
    const id = req.params.id.replace(/[^a-f0-9]/gi, ''); // sanitize
    const filePath = path.join(UPLOADS_DIR, id + '.pdf');
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
    res.setHeader('Content-Type', 'application/pdf');
    res.sendFile(filePath);
});

// ─── View route: serve the flipbook HTML for any /view/:id URL ───
app.get('/view/:id', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ─── Static files ───
app.use(express.static(__dirname));

app.listen(PORT, () => {
    console.log(`\n  Flipbook server running at:`);
    console.log(`  http://localhost:${PORT}\n`);
});
