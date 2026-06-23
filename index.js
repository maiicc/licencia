const { Client, IntentsBitField } = require('discord.js');
const express = require('express');
const { Pool } = require('pg'); // Usamos PG en vez de Mongoose
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// --- 1. CONEXIÓN A POSTGRESQL (Aiven) ---
const pool = new Pool({
    connectionString: process.env.DATABASE_URL, // Aiven te da una URL que empieza por postgres://
    ssl: {
        rejectUnauthorized: false // Necesario para conexiones seguras en la nube
    }
});

// Crear la tabla si no existe al iniciar
const initDB = async () => {
    const queryText = `
        CREATE TABLE IF NOT EXISTS whitelist (
            roblox_id TEXT PRIMARY KEY,
            added_by TEXT,
            added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `;
    try {
        await pool.query(queryText);
        console.log("✅ Tabla de Whitelist lista o ya existente");
    } catch (err) {
        console.error("❌ Error creando tabla:", err);
    }
};
initDB();

app.use(express.json());

// --- 2. API PARA ROBLOX ---
app.get('/verify/:id', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM whitelist WHERE roblox_id = $1', [req.params.id]);
        
        if (result.rows.length > 0) {
            res.status(200).json({ allowed: true });
        } else {
            res.status(403).json({ allowed: false });
        }
    } catch (error) {
        res.status(500).json({ error: "Error en el servidor" });
    }
});

// --- 3. BOT DE DISCORD ---
const client = new Client({ 
    intents: [
        IntentsBitField.Flags.Guilds, 
        IntentsBitField.Flags.GuildMessages, 
        IntentsBitField.Flags.MessageContent
    ] 
});

const PREFIX = "!";
const ADMIN_ID = process.env.ADMIN_ID;

client.on('messageCreate', async (msg) => {
    if (!msg.content.startsWith(PREFIX) || msg.author.bot) return;
    if (msg.author.id !== ADMIN_ID) return;

    const args = msg.content.slice(PREFIX.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    if (command === "whitelist") {
        const id = args[0];
        if (!id) return msg.reply("❌ Uso: !whitelist [ID]");

        try {
            await pool.query('INSERT INTO whitelist (roblox_id, added_by) VALUES ($1, $2)', [id, msg.author.tag]);
            msg.reply(`✅ ID **${id}** añadido a PostgreSQL.`);
        } catch (err) {
            if (err.code === '23505') { // Error de ID duplicado en SQL
                msg.reply("❌ Ese ID ya está en la lista.");
            } else {
                msg.reply(`❌ Error: ${err.message}`);
            }
        }
    }

    if (command === "unwhitelist") {
        const id = args[0];
        if (!id) return msg.reply("❌ Uso: !unwhitelist [ID]");

        try {
            await pool.query('DELETE FROM whitelist WHERE roblox_id = $1', [id]);
            msg.reply(`🗑️ ID **${id}** eliminado.`);
        } catch (err) {
            msg.reply(`❌ Error: ${err.message}`);
        }
    }
});

client.login(process.env.BOT_TOKEN);
app.listen(PORT, () => console.log(`🚀 API con PostgreSQL en puerto ${PORT}`));
