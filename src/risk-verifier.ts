import { evidenceDigest } from "./model.js";
import type { ForecastPreimageV1, ForecastRiskDecision } from "./types.js";

function manifestConfig(evidence: unknown): Record<string, unknown> {
  if (evidence === null || typeof evidence !== "object" || Array.isArray(evidence)) {
    throw new Error("full evidence with model_manifest.config is required for risk verification");
  }
  const manifest = (evidence as Record<string, unknown>).model_manifest;
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("evidence.model_manifest is required for risk verification");
  }
  const config = (manifest as Record<string, unknown>).config;
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("evidence.model_manifest.config is required for risk verification");
  }
  return config as Record<string, unknown>;
}

export function verifyRecordedRiskDecision(
  preimage: ForecastPreimageV1,
  evidence: unknown,
  recorded: ForecastRiskDecision,
): void {
  if (recorded.market_id !== preimage.market_id) throw new Error("risk decision market_id does not match preimage");
  const config = manifestConfig(evidence);
  const edge = config.edge;
  const maxDisagreement = config.max_disagreement;
  if (typeof edge !== "number" || !Number.isFinite(edge) || edge < 0) {
    throw new Error("model manifest edge must be a non-negative finite number");
  }
  if (typeof maxDisagreement !== "number" || !Number.isFinite(maxDisagreement)) {
    throw new Error("model manifest max_disagreement must be a finite number");
  }

  const absoluteEdge = Math.abs(preimage.p_agent - preimage.p_market);
  const allowed = absoluteEdge >= edge && (maxDisagreement <= 0 || absoluteEdge <= maxDisagreement);
  const reason: ForecastRiskDecision["reason"] = absoluteEdge < edge
    ? "below-edge"
    : maxDisagreement > 0 && absoluteEdge > maxDisagreement
      ? "model-disagreement"
      : "edge-band";
  const absoluteEdgeE4 = Math.round(absoluteEdge * 10_000);
  const riskConfigHash = evidenceDigest({
    v: 1,
    edge,
    max_disagreement: maxDisagreement,
    execution: "disabled-recorder-only",
  });

  if (recorded.allowed !== allowed) throw new Error(`risk decision allowed=${recorded.allowed}, derived=${allowed}`);
  if (recorded.reason !== reason) throw new Error(`risk decision reason=${recorded.reason}, derived=${reason}`);
  if (recorded.absolute_edge_e4 !== absoluteEdgeE4) {
    throw new Error(`risk decision absolute_edge_e4=${recorded.absolute_edge_e4}, derived=${absoluteEdgeE4}`);
  }
  if (recorded.risk_config_hash !== riskConfigHash) {
    throw new Error(`risk decision config hash ${recorded.risk_config_hash} does not match sealed config ${riskConfigHash}`);
  }
}
