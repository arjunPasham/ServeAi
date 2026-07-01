interface ETABadgeProps {
  etaMinutes: number | null;
}

export function ETABadge({ etaMinutes }: ETABadgeProps) {
  if (etaMinutes === null) {
    return (
      <span className="text-xs bg-gray-100 text-gray-500 rounded-full px-2 py-0.5">
        ETA unavailable
      </span>
    );
  }

  const color = etaMinutes <= 30 ? 'bg-green-50 text-green-700' : 'bg-yellow-50 text-yellow-700';

  return (
    <span className={`text-xs font-medium rounded-full px-2 py-0.5 ${color}`}>
      ~{etaMinutes} min delivery
    </span>
  );
}
