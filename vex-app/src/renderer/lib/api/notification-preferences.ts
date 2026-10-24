/**
 * The OS notification preferences main owns (`preferences.json`): today only
 * `priceAlertsOs`, whether a fired price alert shows an OS notification when
 * no Vex window is focused (F01). The in-app notice always shows.
 *
 * Plain state rather than a query: the one switch that reads it sits on the
 * Settings page, which renders without a query client in its tests and needs
 * no cache shared with anything else. A preload without the setting reads as
 * the default, on.
 */

import { useCallback, useEffect, useState } from "react";

export interface PriceAlertsOsSetting {
  readonly enabled: boolean;
  readonly busy: boolean;
  readonly setEnabled: (next: boolean) => void;
}

export function usePriceAlertsOsSetting(): PriceAlertsOsSetting {
  const [enabled, setEnabledState] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const read = window.vex?.settings?.getPreferences;
    if (typeof read !== "function") return;
    let cancelled = false;
    void read().then((result) => {
      if (!cancelled && result.ok) setEnabledState(result.data.notifications.priceAlertsOs);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const setEnabled = useCallback((next: boolean) => {
    const write = window.vex?.settings?.setNotificationPreferences;
    if (typeof write !== "function") return;
    setBusy(true);
    setEnabledState(next);
    void write({ priceAlertsOs: next }).then((result) => {
      setBusy(false);
      // Main's answer is the truth; a refused write puts the switch back.
      setEnabledState(result.ok ? result.data.notifications.priceAlertsOs : !next);
    });
  }, []);

  return { enabled, busy, setEnabled };
}
