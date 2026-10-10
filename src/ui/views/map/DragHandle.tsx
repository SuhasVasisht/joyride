// The grip on a card the captain can regroup. Press and drag it (or anywhere on the card) to carry the
// card to another idea or group; click it, or press Enter on it, for the Move to menu. MapView handles
// both by delegation from the chart, so the grip only has to sit inside the element that carries data-drag.

/** Six dots, the usual sign for "this can be picked up". */
export function Grip({ size = 14 }: { size?: number }) {
  return (
    <svg className="grip" width={size * 0.72} height={size} viewBox="0 0 10 14" aria-hidden>
      {[2.5, 7, 11.5].flatMap((y) => [2.5, 7.5].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.35" fill="currentColor" />))}
    </svg>
  );
}

export function DragHandle({ label }: { label: string }) {
  return (
    <button type="button" className="drag-handle" data-drag-handle aria-haspopup="dialog" aria-label={`Move ${label} to…`} title="Drag to move, or click for Move to…">
      <Grip />
    </button>
  );
}
