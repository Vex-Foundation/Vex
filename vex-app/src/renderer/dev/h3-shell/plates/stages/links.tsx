/**
 * The two links the stage screens carry today, drawn inert for the plates:
 * the logs folder (`components/common/OpenLogsLink.tsx`) and the privacy page
 * (`VEX_PRIVACY_DOC_LABEL`, `@shared/docs-links.ts`). Links are ink with an
 * underline in H3 (section 2.3), never blue.
 */

import type { JSX } from "react";
import { VEX_PRIVACY_DOC_LABEL } from "@shared/docs-links.js";
import { LineExternal } from "../../../../components/icons/line/index.js";

export function OpenLogsLinkStandin(): JSX.Element {
  return (
    <button type="button" className="vex-stg__link vex-stg__link--button">
      Open logs folder
    </button>
  );
}

export function PrivacyLinkStandin(): JSX.Element {
  return (
    <span className="vex-stg__link">
      {VEX_PRIVACY_DOC_LABEL}
      <LineExternal size={14} />
    </span>
  );
}
