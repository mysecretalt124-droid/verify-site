const express = require('express');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// ====================== DATA SETUP ======================
const dataDir = path.join(__dirname, 'data');
const usersFilePath = path.join(dataDir, 'users.json');
let authorizedUsers = [];

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

if (fs.existsSync(usersFilePath)) {
    authorizedUsers = JSON.parse(fs.readFileSync(usersFilePath, 'utf8') || '[]');
} else {
    fs.writeFileSync(usersFilePath, '[]');
}

const saveUsers = () => {
    fs.writeFileSync(usersFilePath, JSON.stringify(authorizedUsers, null, 2));
    console.log('✅ Users saved');
};

// ====================== HELPER ======================
async function refreshToken(user) {
    try {
        const res = await fetch('https://discord.com/api/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: process.env.CLIENT_ID,
                client_secret: process.env.CLIENT_SECRET,
                grant_type: 'refresh_token',
                refresh_token: user.refresh_token,
            }),
        });

        const data = await res.json();
        if (data.access_token) {
            user.access_token = data.access_token;
            if (data.refresh_token) user.refresh_token = data.refresh_token;
            saveUsers();
            console.log(`🔄 Refreshed token for ${user.username}`);
            return true;
        }
        return false;
    } catch (e) {
        console.error('Token refresh failed:', e.message);
        return false;
    }
}

// ====================== CALLBACK ======================
app.get('/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.status(400).send('No code received.');

    try {
        const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: process.env.CLIENT_ID,
                client_secret: process.env.CLIENT_SECRET,
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: process.env.REDIRECT_URI,
           
            }),
        });

        const tokenData = await tokenRes.json();

if (!tokenData.access_token) {
    console.log("❌ TOKEN ERROR:", tokenData);
    return res.send("OAuth failed - check logs");
}

        const userRes = await fetch('https://discord.com/api/users/@me', {
            headers: { Authorization: `Bearer ${tokenData.access_token}` },
        });
        const user = await userRes.json();

        console.log(`✅ User verified: ${user.username} (${user.id})`);

        let dbUser = authorizedUsers.find(u => u.id === user.id);
        if (!dbUser) {
            dbUser = {
                id: user.id,
                username: user.username,
                access_token: tokenData.access_token,
                refresh_token: tokenData.refresh_token,   // ← This is the key fix
                joinedGuilds: [],
                webhookSent: false,
            };
            authorizedUsers.push(dbUser);
        } else {
            dbUser.access_token = tokenData.access_token;
            if (tokenData.refresh_token) dbUser.refresh_token = tokenData.refresh_token;
        }
        saveUsers();

        // Join default guild + role
        const defaultGuildId = process.env.GUILD_ID;
        await fetch(`https://discord.com/api/guilds/${defaultGuildId}/members/${user.id}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bot ${process.env.BOT_TOKEN}`,
            },
            body: JSON.stringify({
                access_token: tokenData.access_token,
                roles: [process.env.ROLE_ID],
            }),
        }).then(r => r.text());

        // Send webhook only once
        if (process.env.WEBHOOK_URL && !dbUser.webhookSent) {
            await fetch(process.env.WEBHOOK_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    embeds: [{
                        title: "✅ New User Verified",
                        description: `**${user.username}** (${user.id})\nJoined on <t:${Math.floor(Date.now()/1000)}:F>`,
                        color: 0x00ff00
                    }]
                }),
            });
            dbUser.webhookSent = true;
            saveUsers();
        }

        res.redirect('/success.html');
    } catch (err) {
        console.error(err);
        res.status(500).send('Verification failed.');
    }
});

// ====================== ADMIN API ======================
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/api/users', (req, res) => res.json(authorizedUsers));

app.post('/api/join-guild', async (req, res) => {
    const { guildId, roleId } = req.body;
    if (!guildId) return res.status(400).json({ error: 'Guild ID required' });

    const results = [];

    for (const user of authorizedUsers) {
        if (user.joinedGuilds.includes(guildId)) {
            results.push({ username: user.username, status: 'Already joined' });
            continue;
        }

        let tokenToUse = user.access_token;

        // Try to refresh token if we have a refresh_token
        if (user.refresh_token) {
            const refreshed = await refreshToken(user);
            if (refreshed) tokenToUse = user.access_token;
        }

        try {
            const joinRes = await fetch(`https://discord.com/api/guilds/${guildId}/members/${user.id}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bot ${process.env.BOT_TOKEN}`,
                },
                body: JSON.stringify({
                    access_token: tokenToUse,
                    roles: roleId ? [roleId] : [],
                }),
            });

            const joinData = await joinRes.json().catch(() => ({}));

            if (joinRes.status === 201 || joinRes.status === 204) {
                user.joinedGuilds.push(guildId);
                saveUsers();
                results.push({ username: user.username, status: '✅ Success' });
            } else {
                results.push({ 
                    username: user.username, 
                    status: '❌ Failed', 
                    error: joinData.message || `HTTP ${joinRes.status}` 
                });
            }
        } catch (e) {
            results.push({ username: user.username, status: '❌ Error', error: e.message });
        }
    }

    res.json({ message: `Processed ${authorizedUsers.length} users`, results });
});

app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📌 Admin panel: http://localhost:${PORT}/admin`);
});