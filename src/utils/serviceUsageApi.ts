/**
 * Service Usage API — best-effort Apps Script API enablement.
 *
 * Attempts to enable the Apps Script API on a GCP project via the Service Usage API.
 * Non-fatal: returns a diagnostic result (not throws) on 403 or other errors.
 *
 * Requires: cloud-platform scope or serviceusage.services.enable permission.
 * Since cloud-platform is NOT in GAS_SCOPES, this will typically return 403 for most users,
 * which degrades gracefully to a manual-enable hint.
 */

/** Validates that a GCP project number is numeric and plausible */
const GCP_PROJECT_NUMBER_RE = /^\d{6,20}$/;

export interface EnableApiResult {
  success: boolean;
  alreadyEnabled?: boolean;
  error?: string;
  hint?: string;
}

/**
 * Attempt to enable Apps Script API on the given GCP project.
 * Uses: POST https://serviceusage.googleapis.com/v1/projects/{projectNumber}/services/script.googleapis.com:enable
 * Non-fatal: returns { success: false, hint } on 403/scope errors.
 */
export async function enableAppsScriptApi(
  gcpProjectNumber: string,
  token: string
): Promise<EnableApiResult> {
  if (!GCP_PROJECT_NUMBER_RE.test(gcpProjectNumber)) {
    return {
      success: false,
      error: `Invalid gcpProjectNumber "${gcpProjectNumber}": must be 6–20 digits.`,
      hint: 'Find your GCP project number at console.cloud.google.com > project settings.',
    };
  }

  const url = `https://serviceusage.googleapis.com/v1/projects/${gcpProjectNumber}/services/script.googleapis.com:enable`;

  try {
    const signal = AbortSignal.timeout(30_000);
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
      signal,
    });

    if (response.status === 403 || response.status === 401) {
      const text = await response.text().catch(() => '');
      return {
        success: false,
        error: `Service Usage API returned ${response.status}`,
        hint: `Could not auto-enable Apps Script API (scope/permission insufficient). Manually enable at console.cloud.google.com > APIs & Services > Enable "Apps Script API". Details: ${text.substring(0, 200)}`,
      };
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return {
        success: false,
        error: `Service Usage API returned HTTP ${response.status}: ${text.substring(0, 200)}`,
        hint: 'Manually enable at console.cloud.google.com > APIs & Services > Enable "Apps Script API".',
      };
    }

    // 200 OK — check if it was already enabled or just enabled now
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    // Service Usage API returns an Operation object for :enable.
    // 'done: true' on immediate return = already enabled. 'done: false' = async enable in progress.
    const alreadyEnabled = data.done === true;

    return { success: true, alreadyEnabled };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('TimeoutError') || message.includes('abort')) {
      return {
        success: false,
        error: 'Service Usage API request timed out after 30s',
        hint: 'Manually enable Apps Script API at console.cloud.google.com > APIs & Services.',
      };
    }
    return {
      success: false,
      error: `Service Usage API request failed: ${message}`,
      hint: 'Manually enable Apps Script API at console.cloud.google.com > APIs & Services.',
    };
  }
}
