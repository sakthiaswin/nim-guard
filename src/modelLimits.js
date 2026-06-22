/**
 * Per-model RPM/TPM limits.
 *
 * NVIDIA NIM's free tier limits vary by model and change over time —
 * there is no stable public table to hardcode against. Always set
 * NIM_RPM / NIM_TPM (or per-model overrides below) from your actual
 * NIM dashboard/account limits rather than trusting defaults here.
 *
 * Config precedence (highest wins):
 *   1. MODEL_LIMITS_JSON env var (per-model overrides, see .env.example)
 *   2. NIM_RPM / NIM_TPM env vars (global default for any model)
 *   3. Hardcoded fallback below (conservative, safe-but-slow default)
 */

const FALLBACK_LIMITS = { rpm: 40, tpm: 100000 };

let modelOverrides = {};
try {
  if (process.env.MODEL_LIMITS_JSON) {
    modelOverrides = JSON.parse(process.env.MODEL_LIMITS_JSON);
  }
} catch (e) {
  console.error("[nim-guard] Failed to parse MODEL_LIMITS_JSON, ignoring:", e.message);
}

const globalDefault = {
  rpm: Number(process.env.NIM_RPM) || FALLBACK_LIMITS.rpm,
  tpm: Number(process.env.NIM_TPM) || FALLBACK_LIMITS.tpm,
};

export function getLimitsForModel(model) {
  if (model && modelOverrides[model]) {
    return {
      rpm: modelOverrides[model].rpm ?? globalDefault.rpm,
      tpm: modelOverrides[model].tpm ?? globalDefault.tpm,
    };
  }
  return globalDefault;
}

export function listConfiguredModels() {
  return Object.keys(modelOverrides);
}
