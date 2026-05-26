const express = require('express');
const mysql = require('mysql2');
const bodyParser = require('body-parser');
const session = require('express-session');
const path = require('path');

const app = express();

// Middleware
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
    secret: 'calculator_secret_key',
    resave: false,
    saveUninitialized: true
}));

// MySQL Connection
const db = mysql.createConnection({
    host: 'localhost',
    user: 'root',       
    password: 'Mysqlisop@.?11111', 
    database: 'calculator'
});

db.connect((err) => {
    if (err) {
        console.error('Database connection failed: ' + err.stack);
        return;
    }
    console.log('Connected to MySQL database.');
});

// Middleware to protect routes
function isAuthenticated(req, res, next) {
    if (req.session.user) {
        return next();
    }
    res.redirect('/login.html');
}

// Routes
app.get('/', (req, res) => {
    res.redirect('/login.html');
});

// Handle Login
app.post('/login', (req, res) => {
    const { username, password } = req.body;

    const query = 'SELECT * FROM users WHERE username = ? AND password = ?';
    db.query(query, [username, password], (err, results) => {
        if (err) throw err;

        if (results.length > 0) {
            req.session.user = username; // Set session
            res.redirect('/calculator');
        } else {
            res.send('<h3>Invalid Username or Password</h3><a href="/login.html">Try Again</a>');
        }
    });
});

// Serve Protected Calculator Page
app.get('/calculator', isAuthenticated, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'calculator.html'));
});

// Handle Logout
app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login.html');
});

// Start Server
app.listen(3000, () => {
    console.log('Server running on http://localhost:3000');
});