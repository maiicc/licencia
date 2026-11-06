const crypto = require("crypto");
const express = require("express");
const rateLimit = require("express-rate-limit");
const { Pool } = require("pg");
const {
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder,
  PermissionFlagsBits, MessageFlags, EmbedBuilder,
} = require("discord.js");

const {
  DATABASE_URL, DISCORD_TOKEN, CLIENT_ID, GUILD_ID, OWNER_ID, LOG_CHANNEL_ID,
  PORT = 3000,
} = process.env;

const PRODUCTS = ["overhead", "level", "music", "all"];
const KEY_RE = /^VX-[A-F0-9]{6}(-[A-F0-9]{6}){3}$/;
const EPHEMERAL = MessageFlags.Ephemeral;

// Neon / Supabase exigen SSL
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

function newKey() {
  const hex = crypto.randomBytes(12).toString("hex").toUpperCase();
  return "VX-" + hex.match(/.{6}/g).join("-");
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS licenses (
      id         SERIAL PRIMARY KEY,
      key_hash   TEXT UNIQUE NOT NULL,
      prefix     TEXT UNIQUE NOT NULL,
      product    TEXT NOT NULL,
      buyer      TEXT NOT NULL,
      max_games  INT NOT NULL DEFAULT 1,
      revoked    BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS activations (
      license_id INT NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
      game_id    BIGINT NOT NULL,
      place_id   BIGINT,
      first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (license_id, game_id)
    );
  `);
  await pool.query(`
    ALTER TABLE activations
      ADD COLUMN IF NOT EXISTS game_name  TEXT,
      ADD COLUMN IF NOT EXISTS owner_name TEXT,
      ADD COLUMN IF NOT EXISTS owner_id   BIGINT,
      ADD COLUMN IF NOT EXISTS owner_type TEXT;
  `);
}

// ---------- Discord ----------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const logged = new Map();

// Avisos (texto o embed): al canal si hay LOG_CHANNEL_ID, si no por DM a ti.
// Con "once" se evita repetir el mismo aviso durante 10 minutos.
async function log(content, once) {
  try {
    if (once) {
      const last = logged.get(once);
      if (last && Date.now() - last < 600_000) return;
      logged.set(once, Date.now());
    }
    if (LOG_CHANNEL_ID) {
      const channel = await client.channels.fetch(LOG_CHANNEL_ID);
      await channel.send(content);
    } else {
      const owner = await client.users.fetch(OWNER_ID);
      await owner.send(content);
    }
  } catch (e) {
    console.error("log error:", e.message);
  }
}

// ---------- Helpers de logs ----------
// Los datos vienen del juego del comprador: se limpian antes de mostrarlos
const clean = (v, max = 80) =>
  String(v ?? "?").replace(/[`*_~|>\\@\[\]()]/g, "").replace(/\s+/g, " ").trim().slice(0, max) || "?";

function parseInfo(body) {
  const num = (n) => (Number.isInteger(n) && n >= 0 ? n : null);
  return {
    gameName: clean(body.gameName),
    ownerName: clean(body.ownerName, 40),
    ownerId: num(body.ownerId),
    ownerType: body.ownerType === "Group" ? "Grupo" : body.ownerType === "User" ? "Usuario" : "?",
    players: num(body.players) ?? 0,
  };
}

function ownerUrl(info) {
  if (!info.ownerId) return null;
  return info.ownerType === "Grupo"
    ? `https://www.roblox.com/communities/${info.ownerId}`
    : `https://www.roblox.com/users/${info.ownerId}/profile`;
}

function logEmbed(title, color, lic, product, info, gameId, place, extra) {
  const link = place ? `https://www.roblox.com/games/${place}` : null;
  const oUrl = ownerUrl(info);
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(color)
    .addFields(
      { name: "Licencia", value: `\`${lic.prefix}\` · ${clean(lic.buyer, 60)}`, inline: true },
      { name: "Producto", value: product, inline: true },
      { name: "Juego", value: link ? `[${info.gameName}](${link})` : info.gameName },
      { name: "Dueño", value: oUrl ? `[${info.ownerName}](${oUrl}) (${info.ownerType})` : `${info.ownerName} (${info.ownerType})`, inline: true },
      { name: "GameId / PlaceId", value: `\`${gameId}\` / \`${place ?? "?"}\``, inline: true },
      { name: "Jugadores ahora", value: String(info.players), inline: true },
    )
    .setTimestamp();
  if (extra) embed.setDescription(extra);
  return { embeds: [embed] };
}

// ---------- API ----------
const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "4kb" }));
app.use(rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: true, legacyHeaders: false }));

app.get("/health", (_req, res) => res.send("ok"));

app.post("/verify", async (req, res) => {
  const body = req.body || {};
  const { product, key, gameId, placeId } = body;
  if (
    typeof product !== "string" || typeof key !== "string" ||
    !Number.isInteger(gameId) || gameId <= 0
  ) {
    return res.status(400).json({ ok: false, reason: "bad_request" });
  }
  if (!KEY_RE.test(key)) return res.json({ ok: false, reason: "invalid" });

  const place = Number.isInteger(placeId) && placeId > 0 ? placeId : null;
  const info = parseInfo(body);
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const { rows } = await db.query("SELECT * FROM licenses WHERE key_hash = $1 FOR UPDATE", [sha(key)]);
    const lic = rows[0];
    const deny = async (reason) => {
      await db.query("ROLLBACK");
      return res.json({ ok: false, reason });
    };

    if (!lic) return deny("invalid");
    if (lic.revoked) {
      log(logEmbed("🚫 Licencia revocada en uso", 0xed4245, lic, product, info, gameId, place), `rev:${lic.id}:${gameId}`);
      return deny("revoked");
    }
    if (lic.product !== "all" && lic.product !== product) return deny("product");

    const act = await db.query(
      `UPDATE activations
          SET last_seen = NOW(), place_id = $3, game_name = $4,
              owner_name = $5, owner_id = $6, owner_type = $7
        WHERE license_id = $1 AND game_id = $2`,
      [lic.id, gameId, place, info.gameName, info.ownerName, info.ownerId, info.ownerType]
    );

    if (act.rowCount === 0) {
      const { rows: [{ count }] } = await db.query(
        "SELECT COUNT(*)::int AS count FROM activations WHERE license_id = $1", [lic.id]
      );
      if (count >= lic.max_games) {
        log(
          logEmbed("⚠️ Límite de juegos superado", 0xfee75c, lic, product, info, gameId, place,
            `Intento bloqueado. Límite: ${lic.max_games} juego/s.`),
          `lim:${lic.id}:${gameId}`
        );
        return deny("limit");
      }
      await db.query(
        `INSERT INTO activations (license_id, game_id, place_id, game_name, owner_name, owner_id, owner_type)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [lic.id, gameId, place, info.gameName, info.ownerName, info.ownerId, info.ownerType]
      );
      log(logEmbed("🔗 Nueva activación", 0x57f287, lic, product, info, gameId, place,
        `Juegos usados: ${count + 1}/${lic.max_games}`));
    }

    await db.query("COMMIT");
    res.json({ ok: true });
  } catch (e) {
    await db.query("ROLLBACK").catch(() => {});
    console.error("verify error:", e);
    res.status(500).json({ ok: false, reason: "server_error" });
  } finally {
    db.release();
  }
});

// ---------- Comandos ----------
const keyOption = (o) => o.setName("key").setDescription("Key completa o prefijo (6 caracteres)").setRequired(true);

const commands = [
  new SlashCommandBuilder()
    .setName("license")
    .setDescription("Gestión de licencias")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((s) => s.setName("create").setDescription("Crea una licencia (solo tú ves la key)")
      .addStringOption((o) => o.setName("producto").setDescription("Producto").setRequired(true)
        .addChoices(...PRODUCTS.map((p) => ({ name: p, value: p }))))
      .addStringOption((o) => o.setName("comprador").setDescription("Nombre o nota para identificarlo").setRequired(true).setMaxLength(60))
      .addIntegerOption((o) => o.setName("juegos").setDescription("Máximo de juegos (por defecto 1)").setMinValue(1).setMaxValue(10)))
    .addSubcommand((s) => s.setName("revoke").setDescription("Revoca una licencia").addStringOption(keyOption))
    .addSubcommand((s) => s.setName("restore").setDescription("Reactiva una licencia revocada").addStringOption(keyOption))
    .addSubcommand((s) => s.setName("reset").setDescription("Libera los juegos enlazados").addStringOption(keyOption))
    .addSubcommand((s) => s.setName("info").setDescription("Muestra dónde se usa una licencia").addStringOption(keyOption))
    .addSubcommand((s) => s.setName("list").setDescription("Lista tus licencias (las últimas 25)")
      .addStringOption((o) => o.setName("buscar").setDescription("Filtrar por nombre del comprador"))),
].map((c) => c.toJSON());

async function findLicense(input) {
  const v = input.trim().toUpperCase();
  const q = v.length > 6
    ? await pool.query("SELECT * FROM licenses WHERE key_hash = $1", [sha(v)])
    : await pool.query("SELECT * FROM licenses WHERE prefix = $1", [v.replace(/^VX-/, "")]);
  return q.rows[0];
}

client.on("interactionCreate", async (i) => {
  if (!i.isChatInputCommand() || i.commandName !== "license") return;

  if (i.user.id !== OWNER_ID) {
    return i.reply({ content: "No tienes permiso.", flags: EPHEMERAL });
  }
  await i.deferReply({ flags: EPHEMERAL });

  try {
    const sub = i.options.getSubcommand();

    if (sub === "create") {
      const product = i.options.getString("producto");
      const buyer = i.options.getString("comprador");
      const max = i.options.getInteger("juegos") ?? 1;

      let key, prefix, saved = false;
      for (let n = 0; n < 5 && !saved; n++) {
        key = newKey();
        prefix = key.slice(3, 9);
        try {
          await pool.query(
            "INSERT INTO licenses (key_hash, prefix, product, buyer, max_games) VALUES ($1,$2,$3,$4,$5)",
            [sha(key), prefix, product, buyer, max]
          );
          saved = true;
        } catch (e) {
          if (e.code !== "23505") throw e;
        }
      }
      if (!saved) return i.editReply("No se pudo generar una key única. Intenta de nuevo.");

      return i.editReply(
        `✅ Licencia creada para **${buyer}** (${product}, ${max} juego/s).\n` +
        `Cópiala ahora, **solo se muestra una vez**:\n\`${key}\`\n` +
        `Después la gestionas con el prefijo \`${prefix}\`.`
      );
    }

    if (sub === "list") {
      const search = i.options.getString("buscar");
      const { rows } = search
        ? await pool.query(
            "SELECT prefix, product, buyer, max_games, revoked FROM licenses WHERE buyer ILIKE $1 ORDER BY id DESC LIMIT 25",
            [`%${search}%`])
        : await pool.query(
            "SELECT prefix, product, buyer, max_games, revoked FROM licenses ORDER BY id DESC LIMIT 25");
      if (!rows.length) return i.editReply("No hay licencias.");
      return i.editReply(
        rows.map((r) => `\`${r.prefix}\` · ${r.buyer} · ${r.product} · ${r.max_games} juego/s${r.revoked ? " · 🚫 revocada" : ""}`).join("\n")
      );
    }

    const lic = await findLicense(i.options.getString("key"));
    if (!lic) return i.editReply("Licencia no encontrada.");

    if (sub === "revoke" || sub === "restore") {
      const revoke = sub === "revoke";
      await pool.query("UPDATE licenses SET revoked = $2 WHERE id = $1", [lic.id, revoke]);
      return i.editReply(`Licencia \`${lic.prefix}\` (${lic.buyer}) ${revoke ? "revocada" : "reactivada"}. La revocación aplica cuando un servidor del juego se reinicia.`);
    }

    if (sub === "reset") {
      await pool.query("DELETE FROM activations WHERE license_id = $1", [lic.id]);
      return i.editReply(`Juegos de \`${lic.prefix}\` (${lic.buyer}) liberados.`);
    }

    if (sub === "info") {
      const { rows } = await pool.query(
        "SELECT game_id, place_id, game_name, owner_name, owner_type, last_seen FROM activations WHERE license_id = $1 ORDER BY last_seen DESC LIMIT 10",
        [lic.id]
      );
      const games = rows.length
        ? rows.map((r) => {
            const name = r.game_name || "?";
            const title = r.place_id ? `[${name}](https://www.roblox.com/games/${r.place_id})` : name;
            return `• ${title} · dueño: ${r.owner_name ?? "?"} (${r.owner_type ?? "?"}) · visto <t:${Math.floor(new Date(r.last_seen) / 1000)}:R>`;
          }).join("\n")
        : "Sin usos todavía.";
      return i.editReply(
        `**\`${lic.prefix}\`** · ${lic.product} · ${lic.buyer}\n` +
        `Límite: ${lic.max_games} juego/s · Estado: ${lic.revoked ? "🚫 revocada" : "✅ activa"}\n${games}`
      );
    }
  } catch (e) {
    console.error("command error:", e);
    i.editReply("Error interno. Revisa los logs de Render.").catch(() => {});
  }
});

// ---------- Arranque ----------
(async () => {
  if (!OWNER_ID) throw new Error("Falta la variable OWNER_ID");
  await initDb();
  app.listen(PORT, () => console.log(`API escuchando en :${PORT}`));

  client.once("ready", async () => {
    console.log(`Bot conectado como ${client.user.tag}`);
    const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  });
  await client.login(DISCORD_TOKEN);
})().catch((e) => {
  console.error("Fallo al iniciar:", e);
  process.exit(1);
});
