// Sincroniza las oportunidades de un pipeline de GoHighLevel y genera data.json
// para que el panel HTML (index.html) lo consuma.
//
// Variables de entorno esperadas:
//   GHL_API_TOKEN       Private Integration Token de GHL (secreto, obligatorio)
//   GHL_LOCATION_ID     Location ID de la sub-cuenta
//   GHL_PIPELINE_NAME   Nombre exacto del pipeline a mostrar
//   GHL_DESC_FIELD_KEY  fieldKey del custom field de descripcion (ej: opportunity.descripcion)

import fs from "fs";

const TOKEN = process.env.GHL_API_TOKEN;
const LOCATION_ID = process.env.GHL_LOCATION_ID;
const PIPELINE_NAME = process.env.GHL_PIPELINE_NAME;
const DESC_FIELD_KEY = process.env.GHL_DESC_FIELD_KEY || "opportunity.descripcion";
const PRIORITY_FIELD_KEY = process.env.GHL_PRIORITY_FIELD_KEY || "opportunity.prioridad";

if (!TOKEN) {
    console.error("Falta GHL_API_TOKEN (secreto del repo).");
    process.exit(1);
}
if (!LOCATION_ID) {
    console.error("Falta GHL_LOCATION_ID.");
    process.exit(1);
}
if (!PIPELINE_NAME) {
    console.error("Falta GHL_PIPELINE_NAME.");
    process.exit(1);
}

const BASE = "https://services.leadconnectorhq.com";
const HEADERS = {
    Authorization: `Bearer ${TOKEN}`,
    Version: "2021-07-28",
    Accept: "application/json",
};

const COLUMN_ORDER = [
  { label: "Mejora Detectada", stageName: "MEJORA DETECTADA" },
  { label: "En marcha", stageName: "EN MARCHA" },
    { label: "Stand By / Descartada", stageName: "STAND BY / DESCARTADA" },
    { label: "Terminada", stageName: "TERMINADA" },
  ];

function norm(str) {
    return (str || "").trim().toUpperCase();
}

async function ghlFetch(url) {
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) {
          const body = await res.text().catch(() => "");
          throw new Error(`GET ${url} -> ${res.status} ${res.statusText}\n${body}`);
    }
    return res.json();
}

async function findPipeline() {
    const data = await ghlFetch(`${BASE}/opportunities/pipelines?locationId=${LOCATION_ID}`);
    const pipelines = data.pipelines || [];
    const pipeline = pipelines.find((p) => norm(p.name) === norm(PIPELINE_NAME));
    if (!pipeline) {
          const names = pipelines.map((p) => p.name).join(", ");
          throw new Error(`No se encontro el pipeline "${PIPELINE_NAME}". Pipelines disponibles: ${names}`);
    }
    return pipeline;
}

async function findDescriptionFieldId() {
    try {
          const data = await ghlFetch(`${BASE}/locations/${LOCATION_ID}/customFields?model=all`);
          const fields = data.customFields || data.fields || [];
const match = fields.find(
                  (f) =>
                            norm(f.fieldKey) === norm(DESC_FIELD_KEY) ||
                            norm(f.fieldKey).endsWith(norm(DESC_FIELD_KEY.split(".").pop())) ||
                            (f.name || "").toLowerCase().includes("descrip")
                );
          return match ? match.id : null;
    } catch (err) {
          console.warn("Aviso: no se pudieron leer los custom fields:", err.message);
          return null;
    }
}
async function findPriorityFieldId() {
    try {
        const data = await ghlFetch(`${BASE}/locations/${LOCATION_ID}/customFields?model=all`);
        const fields = data.customFields || data.fields || [];
        const match = fields.find((f) => norm(f.fieldKey) === norm(PRIORITY_FIELD_KEY));
        return match ? match.id : null;
    } catch (err) {
        return null;
    }
}
async function fetchAllOpportunities(pipelineId) {
    const opportunities = [];
    let startAfter;
    let startAfterId;

  while (true) {
        const params = new URLSearchParams({
                location_id: LOCATION_ID,
                pipeline_id: pipelineId,
                limit: "100",
        });
        if (startAfter) params.set("startAfter", startAfter);
        if (startAfterId) params.set("startAfterId", startAfterId);

      const data = await ghlFetch(`${BASE}/opportunities/search?${params.toString()}`);
        const batch = data.opportunities || [];
        opportunities.push(...batch);

      const meta = data.meta || {};
        if (!meta.startAfter || batch.length < 100) break;
        startAfter = meta.startAfter;
        startAfterId = meta.startAfterId;
  }

  return opportunities;
}

function extractDescription(opportunity, descFieldId) {
    if (!descFieldId || !Array.isArray(opportunity.customFields)) return "";
    const cf = opportunity.customFields.find((c) => c.id === descFieldId);
    if (!cf) return "";
    if (typeof cf.fieldValueString === "string") return cf.fieldValueString;
    if (typeof cf.fieldValue === "string") return cf.fieldValue;
    if (Array.isArray(cf.fieldValueArray)) return cf.fieldValueArray.join(", ");
    return "";
}

async function main() {
    const pipeline = await findPipeline();
    const descFieldId = await findDescriptionFieldId();
    const priorityFieldId = await findPriorityFieldId();
    
  const stageIdByName = {};
    for (const stage of pipeline.stages || []) {
          stageIdByName[norm(stage.name)] = stage.id;
    }

  const columnIndexByStageId = {};
    COLUMN_ORDER.forEach((col, idx) => {
          const stageId = stageIdByName[norm(col.stageName)];
          if (stageId) columnIndexByStageId[stageId] = idx;
          else console.warn(`Aviso: no se encontro el stage "${col.stageName}" en el pipeline.`);
    });

  const opportunities = await fetchAllOpportunities(pipeline.id);

  const columns = COLUMN_ORDER.map((col) => ({ label: col.label, opportunities: [] }));

  for (const opp of opportunities) {
        const idx = columnIndexByStageId[opp.pipelineStageId];
        if (idx === undefined) continue;
        columns[idx].opportunities.push({
                id: opp.id,
                name: opp.name || "(sin nombre)",
                description: extractDescription(opp, descFieldId),
            priority: extractDescription(opp, priorityFieldId),
        });
  }

  const output = {
        updatedAt: new Date().toISOString(),
        pipeline: pipeline.name,
        columns,
  };

  fs.writeFileSync("data.json", JSON.stringify(output, null, 2));
    console.log(`OK: ${opportunities.length} oportunidades procesadas, data.json actualizado.`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
