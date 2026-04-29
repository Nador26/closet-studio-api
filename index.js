const express = require("express");
const cors = require("cors");
const Anthropic = require("@anthropic-ai/sdk");
require("dotenv").config();

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "50mb" }));

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// ─── Domaines autorisés ───────────────────────────────────────────────────────
const ALLOWED_DOMAINS = [
  "zara.com", "hm.com", "asos.com", "vinted.fr", "vinted.com",
  "zalando.fr", "zalando.com", "shein.com", "mango.com", "uniqlo.com",
  "sezane.com", "ba-sh.com", "claudiepierlot.com", "rouje.com",
  "nike.com", "adidas.fr", "adidas.com", "newbalance.com",
  "res.cloudinary.com", "images.unsplash.com", "cdn.shopify.com",
  "static.zara.net", "lp2.hm.com", "eurekaddress.com",
  "image.uniqlo.com", "img.ltwebstatic.com",
];

// ─── Extensions image autorisées ─────────────────────────────────────────────
const ALLOWED_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".avif", ".gif"];

function isAllowedUrl(url) {
  try {
    const parsed = new URL(url);

    // ✅ HTTPS uniquement
    if (parsed.protocol !== "https:") return { ok: false, reason: "URL non sécurisée (HTTPS requis)" };

    // ✅ Vérifie le domaine
    const hostname = parsed.hostname.toLowerCase();
    const domainAllowed = ALLOWED_DOMAINS.some(d => hostname === d || hostname.endsWith("." + d));

    // ✅ Vérifie l'extension (si pas de domaine autorisé, l'extension doit être image)
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

// ─── Télécharge l'image et la convertit en base64 ────────────────────────────
async function fetchImageAsBase64(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; ClosetStudio/1.0)",
        "Accept": "image/*",
      },
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.startsWith("image/")) {
      throw new Error("L'URL ne pointe pas vers une image");
    }

    const buffer = await response.arrayBuffer();
    const base64 = Buffer.from(buffer).toString("base64");
    const mediaType = contentType.split(";")[0].trim();

    return { base64, mediaType };
  } finally {
    clearTimeout(timeout);
  }
}

const VISION_PROMPT = `Tu es un expert en mode. Regarde cette image attentivement.

ÉTAPE 1 : Est-ce que cette image montre UN vêtement ou UN accessoire de mode isolé (t-shirt, pantalon, chaussure, sac, bijou, veste, robe, etc.) ?

Si l'image montre une personne, un animal, un paysage, de la nourriture, un objet non vestimentaire, ou n'importe quoi d'autre qu'un vêtement ou accessoire isolé → réponds UNIQUEMENT :
{"error": "not_clothing"}

Si et SEULEMENT si c'est un vêtement ou accessoire → réponds avec ce JSON :
{
  "label": "nom précis du vêtement",
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
  res.json({ status: "ok", message: "Closet Studio API" });
});

// ─── Analyser un vêtement ─────────────────────────────────────────────────────
app.post("/analyze", async (req, res) => {
  try {
    const { imageUrl } = req.body;
    if (!imageUrl) return res.status(400).json({ error: "imageUrl requis" });

    // ✅ Vérifie la sécurité de l'URL
    const urlCheck = isAllowedUrl(imageUrl);
    if (!urlCheck.ok) {
      return res.status(400).json({ error: urlCheck.reason });
    }

    let imageSource;

    // ✅ Essaie d'abord avec l'URL directe (plus rapide)
    // Si ça échoue, télécharge l'image côté serveur
    try {
      // Test rapide : Cloudinary et URLs directes fonctionnent bien avec URL
      const isCloudinary = imageUrl.includes("cloudinary.com");
      const isDirectImage = ALLOWED_EXTENSIONS.some(ext => imageUrl.toLowerCase().includes(ext));

      if (isCloudinary || isDirectImage) {
        // URL directe → Claude peut y accéder
        imageSource = { type: "url", url: imageUrl };
      } else {
        // Site e-commerce → télécharge côté serveur
        const { base64, mediaType } = await fetchImageAsBase64(imageUrl);
        imageSource = { type: "base64", media_type: mediaType, data: base64 };
      }
    } catch (fetchErr) {
      console.log("⚠️ Fetch échoué, essai URL directe:", fetchErr.message);
      imageSource = { type: "url", url: imageUrl };
    }

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 1000,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: imageSource },
          { type: "text", text: VISION_PROMPT },
        ],
      }],
    });

    const text = response.content.map(b => b.text || "").join("");
    const analysis = JSON.parse(text.replace(/```json|```/g, "").trim());
    res.json(analysis);
  } catch (error) {
    console.error("Erreur analyze:", error.message);

    // ✅ Messages d'erreur clairs selon le problème
    if (error.message.includes("fetch") || error.message.includes("network")) {
      return res.status(400).json({ error: "Impossible d'accéder à cette image. Essaie de copier l'URL directe de l'image." });
    }
    if (error.message.includes("not an image") || error.message.includes("image/")) {
      return res.status(400).json({ error: "Ce lien ne pointe pas vers une image valide." });
    }
    res.status(500).json({ error: error.message });
  }
});

// ─── Générer des tenues ───────────────────────────────────────────────────────
app.post("/generate-outfits", async (req, res) => {
  try {
    const { items, mood, profile } = req.body;
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

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 2500,
      messages: [{
        role: "user",
        content: `Tu es un expert en mode. L'utilisateur a ces vêtements :
${JSON.stringify(allItems, null, 2)}

Profil : genre=${profile?.genre || "non spécifié"}, styles=${(profile?.styles || []).join(", ")}, couleurs=${(profile?.couleurs || []).join(", ")}
Mood : ${mood?.label || "casual"}
Météo : 18°C, printemps.

Crée exactement 5 suggestions de tenues DIFFÉRENTES en utilisant UNIQUEMENT les vêtements de la liste.
Réponds UNIQUEMENT en JSON :
[
  {
    "titre": "Nom court et stylé",
    "description": "Description courte (max 15 mots)",
    "contexte": "Pour quelle occasion",
    "pieces": [
      {"id": "id", "label": "nom", "subcategory": "sous-catégorie", "uri": "url"}
    ]
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
  console.log(`✅ Closet Studio API running on port ${port}`);
});