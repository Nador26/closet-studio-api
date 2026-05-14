const express = require("express");
const cors = require("cors");
const Anthropic = require("@anthropic-ai/sdk");
const { Pool } = require("pg");
require("dotenv").config();

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "50mb" }));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── PostgreSQL ───────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

// ─── Créer les tables si elles n'existent pas ─────────────────────────────────
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL DEFAULT 'default',
        label TEXT NOT NULL,
        category TEXT,
        subcategory TEXT,
        color TEXT,
        motif TEXT,
        style TEXT,
        saison TEXT,
        marque TEXT,
        matiere TEXT,
        uri TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS favorites (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL DEFAULT 'default',
        data JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log("✅ Base de données initialisée");
  } catch (e) {
    console.error("❌ Erreur init DB:", e.message);
  }
}

initDB();

// ─── Sécurité URL ─────────────────────────────────────────────────────────────
const ALLOWED_DOMAINS = [
  "zara.com", "hm.com", "asos.com", "vinted.fr", "vinted.com",
  "zalando.fr", "zalando.com", "shein.com", "mango.com", "uniqlo.com",
  "sezane.com", "ba-sh.com", "claudiepierlot.com", "rouje.com",
  "nike.com", "adidas.fr", "adidas.com", "newbalance.com",
  "res.cloudinary.com", "images.unsplash.com", "cdn.shopify.com",
  "static.zara.net", "lp2.hm.com", "image.uniqlo.com", "img.ltwebstatic.com",
];

const ALLOWED_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".avif", ".gif"];

function isAllowedUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return { ok: false, reason: "URL non sécurisée (HTTPS requis)" };
    const hostname = parsed.hostname.toLowerCase();
    const domainAllowed = ALLOWED_DOMAINS.some(d => hostname === d || hostname.endsWith("." + d));
    const pathname = parsed.pathname.toLowerCase();
    const hasImageExtension = ALLOWED_EXTENSIONS.some(ext => pathname.endsWith(ext));
    if (!domainAllowed && !hasImageExtension) {
      return { ok: false, reason: "Ce site n'est pas autorisé. Essaie avec une URL directe vers une image (.jpg, .png, .webp)" };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "URL invalide" };
  }
}

async function fetchImageAsBase64(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ClosetStudio/1.0)", "Accept": "image/*" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.startsWith("image/")) throw new Error("L'URL ne pointe pas vers une image");
    const buffer = await response.arrayBuffer();
    const base64 = Buffer.from(buffer).toString("base64");
    const mediaType = contentType.split(";")[0].trim();
    return { base64, mediaType };
  } finally {
    clearTimeout(timeout);
  }
}

const VISION_PROMPT = `Tu es un expert en mode. Regarde cette image attentivement.

Cette image peut montrer :
- Un vêtement ou accessoire isolé sur fond blanc
- Une tenue portée par une personne ou un mannequin
- Une photo de mode ou lookbook

Si l'image ne montre VRAIMENT rien de vestimentaire (animal, paysage, nourriture, objet non vestimentaire) → réponds UNIQUEMENT : {"error": "not_clothing"}

Si tu vois UN vêtement principal ou une tenue → identifie la pièce principale et réponds avec ce JSON :
{
  "label": "nom précis du vêtement principal",
  "category": "hauts | bas | robes | vestes | chaussures | accessoires | nuit | tenues",
  "subcategory": "tshirts | chemises | blouses | pulls | sweats | debardeurs | polos | jeans | pantalons | shorts | jogging | jupes | robe_casual | robe_soiree | combinaisons_longues | combishorts | vestes_legeres | blazers | manteaux | doudounes | trenchs | baskets | bottes | sandales | talons | mocassins | sport_shoes | sacs | ceintures | bijoux | lunettes | chapeaux | echarpes | montres | sous_vetements | pyjamas | lingerie | chaussettes | look_casual | look_chic | look_sport | look_soiree",
  "color": "couleur principale",
  "motif": "uni | raye | imprime | carreaux | floral | animal | tie_dye | broderie",
  "style": "casual | chic | sport | streetwear | business | boheme | vintage",
  "saison": "ete | hiver | printemps | automne | toutes",
  "marque": "marque si visible sinon null",
  "matiere": "matière principale si identifiable sinon null",
  "confidence": "high | medium | low"
}
Réponds UNIQUEMENT avec le JSON, rien d'autre.`;

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "Closet Studio API + PostgreSQL" });
});

// ═══════════════════════════════════════════════════
// ROUTES ITEMS
// ═══════════════════════════════════════════════════

// GET tous les items
app.get("/items", async (req, res) => {
  try {
    const userId = req.query.user_id || "default";
    const result = await pool.query(
      "SELECT * FROM items WHERE user_id = $1 ORDER BY created_at DESC",
      [userId]
    );
    // Regroupe par sous-catégorie comme l'app l'attend
    const grouped = {};
    result.rows.forEach(item => {
      if (!grouped[item.subcategory]) grouped[item.subcategory] = [];
      grouped[item.subcategory].push({
        id: item.id,
        label: item.label,
        category: item.category,
        subcategory: item.subcategory,
        color: item.color,
        motif: item.motif,
        style: item.style,
        saison: item.saison,
        marque: item.marque,
        matiere: item.matiere,
        uri: item.uri,
      });
    });
    res.json(grouped);
  } catch (e) {
    console.error("Erreur GET /items:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST ajouter un item
app.post("/items", async (req, res) => {
  try {
    const userId = req.query.user_id || "default";
    const { id, label, category, subcategory, color, motif, style, saison, marque, matiere, uri } = req.body;
    await pool.query(
      `INSERT INTO items (id, user_id, label, category, subcategory, color, motif, style, saison, marque, matiere, uri)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (id) DO UPDATE SET label = $3, uri = $12`,
      [id, userId, label, category, subcategory, color, motif, style, saison, marque, matiere, uri]
    );
    res.json({ success: true });
  } catch (e) {
    console.error("Erreur POST /items:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// PATCH renommer un item
app.patch("/items/:id", async (req, res) => {
  try {
    const userId = req.query.user_id || "default";
    const { label } = req.body;
    await pool.query(
      "UPDATE items SET label = $1 WHERE id = $2 AND user_id = $3",
      [label, req.params.id, userId]
    );
    res.json({ success: true });
  } catch (e) {
    console.error("Erreur PATCH /items:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// DELETE supprimer un item
app.delete("/items/:id", async (req, res) => {
  try {
    const userId = req.query.user_id || "default";
    await pool.query(
      "DELETE FROM items WHERE id = $1 AND user_id = $2",
      [req.params.id, userId]
    );
    res.json({ success: true });
  } catch (e) {
    console.error("Erreur DELETE /items:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════
// ROUTES FAVORITES
// ═══════════════════════════════════════════════════

// GET tous les favoris
app.get("/favorites", async (req, res) => {
  try {
    const userId = req.query.user_id || "default";
    const result = await pool.query(
      "SELECT * FROM favorites WHERE user_id = $1 ORDER BY created_at DESC",
      [userId]
    );
    res.json(result.rows.map(r => r.data));
  } catch (e) {
    console.error("Erreur GET /favorites:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST ajouter un favori
app.post("/favorites", async (req, res) => {
  try {
    const userId = req.query.user_id || "default";
    const { id, ...rest } = req.body;
    await pool.query(
      `INSERT INTO favorites (id, user_id, data) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO NOTHING`,
      [id, userId, JSON.stringify({ id, ...rest })]
    );
    res.json({ success: true });
  } catch (e) {
    console.error("Erreur POST /favorites:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// DELETE supprimer un favori
app.delete("/favorites/:id", async (req, res) => {
  try {
    const userId = req.query.user_id || "default";
    await pool.query(
      "DELETE FROM favorites WHERE id = $1 AND user_id = $2",
      [req.params.id, userId]
    );
    res.json({ success: true });
  } catch (e) {
    console.error("Erreur DELETE /favorites:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════
// ANALYSER UN VÊTEMENT
// ═══════════════════════════════════════════════════
app.post("/analyze", async (req, res) => {
  try {
    const { imageUrl } = req.body;
    if (!imageUrl) return res.status(400).json({ error: "imageUrl requis" });

    const urlCheck = isAllowedUrl(imageUrl);
    if (!urlCheck.ok) return res.status(400).json({ error: urlCheck.reason });

    let imageSource;
    try {
      const isCloudinary = imageUrl.includes("cloudinary.com");
      const isDirectImage = ALLOWED_EXTENSIONS.some(ext => imageUrl.toLowerCase().includes(ext));
      if (isCloudinary || isDirectImage) {
        imageSource = { type: "url", url: imageUrl };
      } else {
        const { base64, mediaType } = await fetchImageAsBase64(imageUrl);
        imageSource = { type: "base64", media_type: mediaType, data: base64 };
      }
    } catch {
      imageSource = { type: "url", url: imageUrl };
    }

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 1000,
      messages: [{ role: "user", content: [{ type: "image", source: imageSource }, { type: "text", text: VISION_PROMPT }] }],
    });

    const text = response.content.map(b => b.text || "").join("");
    const analysis = JSON.parse(text.replace(/```json|```/g, "").trim());
    res.json(analysis);
  } catch (error) {
    console.error("Erreur analyze:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// ═══════════════════════════════════════════════════
// GÉNÉRER DES TENUES
// ═══════════════════════════════════════════════════
app.post("/generate-outfits", async (req, res) => {
  try {
    const { items, mood, profile, weather } = req.body;
    if (!items) return res.status(400).json({ error: "items requis" });

    const allItems = [];
    Object.entries(items).forEach(([subId, arr]) => {
      arr.forEach(item => allItems.push({
        id: item.id, label: item.label,
        subcategory: subId, color: item.color || "",
        style: item.style || "", uri: item.uri,
      }));
    });

    if (allItems.length === 0) return res.json([]);

    const weatherDesc = weather
      ? `Météo actuelle : ${weather.temp}°C, ${weather.description}, ressenti ${weather.feels_like}°C.`
      : "Météo : 18°C, printemps.";

    let tempAdvice = "";
    if (weather) {
      if (weather.temp < 5) tempAdvice = "Il fait très froid : privilégie manteaux, pulls épais, écharpes.";
      else if (weather.temp < 12) tempAdvice = "Il fait frais : veste ou manteau recommandé.";
      else if (weather.temp < 18) tempAdvice = "Temps doux : une veste légère peut être utile.";
      else if (weather.temp < 25) tempAdvice = "Temps agréable : tenues légères adaptées.";
      else tempAdvice = "Il fait chaud : privilégie les tenues légères et respirantes.";
    }

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 2500,
      messages: [{
        role: "user",
        content: `Tu es un expert en mode et styliste personnel.

L'utilisateur a ces vêtements :
${JSON.stringify(allItems, null, 2)}

Profil : genre=${profile?.genre || "non spécifié"}, styles=${(profile?.styles || []).join(", ")}, couleurs=${(profile?.couleurs || []).join(", ")}
Mood : ${mood?.label || "casual"} ${mood?.emoji || ""}
${weatherDesc}
${tempAdvice}

Crée exactement 5 suggestions de tenues DIFFÉRENTES en utilisant UNIQUEMENT les vêtements de la liste.
Réponds UNIQUEMENT en JSON :
[
  {
    "titre": "Nom court et stylé",
    "description": "Description courte (max 15 mots)",
    "contexte": "Pour quelle occasion",
    "pieces": [{"id": "id", "label": "nom", "subcategory": "sous-catégorie", "uri": "url"}]
  }
]`,
      }],
    });

    const text = response.content.map(b => b.text || "").join("");
    const outfits = JSON.parse(text.replace(/```json|```/g, "").trim());
    res.json(outfits);
  } catch (error) {
    console.error("Erreur generate-outfits:", error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(port, () => {
  console.log(`✅ Closet Studio API + PostgreSQL running on port ${port}`);
});