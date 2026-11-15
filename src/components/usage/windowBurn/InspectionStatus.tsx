/** The inspected point, read aloud: a polite live region a screen reader
 * follows as the arrow keys move the point — a tooltip's changing text on an
 * already-focused plot is not reliably announced. Visually hidden. */
export function InspectionStatus({ text }: { text: string }) {
  return (
    <span className="usage-burn-status" role="status" aria-live="polite">
      {text}
    </span>
  );
}
