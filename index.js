const express = require("express");
const cors = require("cors");
const Anthropic = require("@anthropic-ai/sdk");
require("dotenv").config();

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "50mb" }));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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

ÉTAPE 1 : Est-ce que cette image montre UN vêtement ou UN accessoire de mode isolé ?

Si ce n'est PAS un vêtement → réponds UNIQUEMENT : {"error": "not_clothing"}

Si c'est un vêtement → réponds avec ce JSON :
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

// ─── Générer des tenues (avec météo) ─────────────────────────────────────────
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

    // ✅ Description météo pour Claude
    const weatherDesc = weather
      ? `Météo actuelle : ${weather.temp}°C, ${weather.description}, ressenti ${weather.feels_like}°C, humidité ${weather.humidity}%.`
      : "Météo : 18°C, printemps (donnée non disponible).";

    // ✅ Conseils vestimentaires selon température
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

L'utilisateur a ces vêtements dans sa garde-robe :
${JSON.stringify(allItems, null, 2)}

Profil utilisateur :
- Genre : ${profile?.genre || "non spécifié"}
- Styles préférés : ${(profile?.styles || []).join(", ") || "non spécifié"}
- Couleurs préférées : ${(profile?.couleurs || []).join(", ") || "non spécifié"}

Mood du jour : ${mood?.label || "casual"} ${mood?.emoji || ""}

${weatherDesc}
${tempAdvice}

Crée exactement 5 suggestions de tenues DIFFÉRENTES en utilisant UNIQUEMENT les vêtements de la liste.
Les tenues doivent être adaptées à la météo ET au mood de l'utilisateur.
Si il fait froid, n'oublie pas d'inclure des vestes/manteaux. Si il fait chaud, évite les layering.

Réponds UNIQUEMENT en JSON :
[
  {
    "titre": "Nom court et stylé de la tenue",
    "description": "Description courte et inspirante (max 15 mots)",
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