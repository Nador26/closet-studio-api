const express = require("express");
const cors = require("cors");
const Anthropic = require("@anthropic-ai/sdk");
require("dotenv").config();

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "10mb" }));

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// ─── Health check ─────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "Closet Studio API" });
});

// ─── Analyser un vêtement ─────────────────────────
app.post("/analyze", async (req, res) => {
  try {
    const { imageBase64, mediaType = "image/jpeg" } = req.body;
    if (!imageBase64) return res.status(400).json({ error: "imageBase64 requis" });

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      messages: [{
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: mediaType, data: imageBase64 },
          },
          {
            type: "text",
            text: `Tu es un expert en mode. Analyse ce vêtement et réponds UNIQUEMENT en JSON :
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
Réponds UNIQUEMENT avec le JSON, rien d'autre.`,
          },
        ],
      }],
    });

    const text = response.content.map(b => b.text || "").join("");
    const analysis = JSON.parse(text.replace(/```json|```/g, "").trim());
    res.json(analysis);
  } catch (error) {
    console.error("Erreur analyze:", error);
    res.status(500).json({ error: error.message });
  }
});

// ─── Générer des tenues ───────────────────────────
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
      model: "claude-sonnet-4-20250514",
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