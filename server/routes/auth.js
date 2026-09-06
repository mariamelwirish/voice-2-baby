const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { generateRawToken, hashToken } = require('../utils/tokens');
const { notifyPasswordReset } = require('../utils/ses');

// POST /api/v1/auth/login
router.post('/login', async (req, res) => {
    // try, catch block to handle errors
    try {
        // destructure email and password from request body
        const {email, password} = req.body;

        // Validate input 
        if(! email || !password) {
            return res.status(400).json({error: 'Email and password are required'});
        }

        // Find user by email
        /* 
            FOR ME:
                1. asynchronous operation: sends a query to MySQL and waits for the response.
                2. await pauses this function until the response arrives, then continues. 
                3. ? is a placeholder. mysql2 replaces it with the value from the array [email]
        */
        const [rows] = await pool.query( 
            'SELECT * FROM users WHERE email = ? AND is_active = TRUE', 
            [email]
        );

        if(rows.length === 0) {
            return res.status(401).json({error: 'Invalid credentials'});
        }

        const user = rows[0];

        // Check Password.
        const passwordMatch = await bcrypt.compare(password, user.password_hash);
        if(!passwordMatch) {
            return res.status(401).json({error: 'Invalid credentials'});
        }

        // Generate JWT Token
        const token = jwt.sign(
            {id: user.id, role: user.role}, // Payload
            process.env.JWT_SECRET, // Secret Key
            {expiresIn: process.env.JWT_EXPIRES_IN}
        );

        // Return response: JWT Token + Basic User Info.
        /* FOR ME: The frontend stores the token and sends it with every subsequent request. */
        res.json({
            token, 
            user: {
                id: user.id,
                hospital_id: user.hospital_id,
                first_name: user.first_name,
                last_name: user.last_name,
                email: user.email,
                role: user.role
            }
        });


    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/v1/auth/signup
router.post('/signup', async(req, res) => {
    try {
        // Signup request requires invite token (from email invite) and password.
        const {token, password} = req.body;

        if(!token || !password) {
            return res.status(400).json({error: 'Token and password are required.'});
        }

        if(password.length < 8) {
            return res.status(400).json({error: 'Password must be at least 8 characters.'});
        }

        // Hash the incoming raw token to match against the stored hash.
        // DB holds the hash, so we hash BEFORE looking up.
        const tokenHash = hashToken(token);

        // Find user by invite token (hash-vs-hash).
        // Three conditions must all be true -> token exists, not used, not expired.
        const [rows] = await pool.query(
            'SELECT * FROM users WHERE invite_token = ? AND invite_used = FALSE AND invite_token_expires_at > NOW()',
            [tokenHash]
        );

        if(rows.length === 0) {
            return res.status(400).json({error: 'Invalid or expired invite token.'});
        }

        const user = rows[0];

        // Hash password.
        const password_hash = await bcrypt.hash(password, 12); // cost factor 12.

        // Activate Account: store hashed password, mark token used, clear the stored hash.
        await pool.query(
            'UPDATE users SET password_hash = ?, invite_used = TRUE, invite_token = NULL WHERE id = ?',
            [password_hash, user.id]
        );

        res.status(200).json({ message: 'Account activated successfully. You can now log in.' });

    } catch (err) {
        console.error('Signup error:', err);
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// POST /api/v1/auth/forgot-password
// Emails a reset link if the address belongs to an active account. Always
// responds 200 with the same generic message so the endpoint can't be used to
// discover which emails have accounts (no user enumeration).
router.post('/forgot-password', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) {
            return res.status(400).json({ error: 'Email is required.' });
        }

        const [rows] = await pool.query(
            'SELECT * FROM users WHERE email = ? AND is_active = TRUE',
            [email]
        );

        // Only send if the account exists AND has already been activated (has a
        // password). Un-activated invitees should finish signup, not reset.
        if (rows.length > 0 && rows[0].invite_used) {
            const user = rows[0];
            const rawToken = generateRawToken();
            const tokenHash = hashToken(rawToken);

            // Store the hash + a 1-hour expiry. Overwrites any prior reset token.
            await pool.query(
                'UPDATE users SET reset_token = ?, reset_token_expires_at = DATE_ADD(NOW(), INTERVAL 1 HOUR) WHERE id = ?',
                [tokenHash, user.id]
            );

            // Email delivery failures shouldn't leak account existence or 500 the
            // request — log and still return the generic success below.
            try {
                await notifyPasswordReset(user.email, user.first_name, rawToken);
            } catch (mailErr) {
                console.error('Password reset email failed:', mailErr);
            }
        }

        res.json({ message: 'If an account exists for that email, a reset link has been sent.' });

    } catch (err) {
        console.error('Forgot-password error:', err);
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// POST /api/v1/auth/reset-password
// Consumes a reset token (from the emailed link) and sets a new password.
router.post('/reset-password', async (req, res) => {
    try {
        const { token, password } = req.body;

        if (!token || !password) {
            return res.status(400).json({ error: 'Token and password are required.' });
        }
        if (password.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters.' });
        }

        // Hash the incoming raw token to match the stored hash, and require it to
        // be unexpired.
        const tokenHash = hashToken(token);
        const [rows] = await pool.query(
            'SELECT * FROM users WHERE reset_token = ? AND reset_token_expires_at > NOW()',
            [tokenHash]
        );

        if (rows.length === 0) {
            return res.status(400).json({ error: 'This reset link is invalid or has expired.' });
        }

        const user = rows[0];
        const password_hash = await bcrypt.hash(password, 12); // same cost as signup.

        // Set the new password and burn the token so the link can't be reused.
        await pool.query(
            'UPDATE users SET password_hash = ?, reset_token = NULL, reset_token_expires_at = NULL WHERE id = ?',
            [password_hash, user.id]
        );

        res.json({ message: 'Your password has been reset. You can now log in.' });

    } catch (err) {
        console.error('Reset-password error:', err);
        res.status(500).json({ error: 'Internal server error.' });
    }
});


module.exports = router;
