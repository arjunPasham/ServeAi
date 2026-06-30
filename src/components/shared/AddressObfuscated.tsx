// Shows a neighborhood-level label — never the real street address.
// Per TRD §2.8: donor address obfuscated to ~500m grid for consumer-facing views.
interface AddressObfuscatedProps {
  approxLat?: number;
  approxLng?: number;
  label?: string;
}

export function AddressObfuscated({ approxLat, approxLng, label }: AddressObfuscatedProps) {
  if (label) {
    return <span className="text-sm text-gray-500">{label}</span>;
  }

  if (approxLat !== undefined && approxLng !== undefined) {
    return (
      <span className="text-sm text-gray-500">
        Near {approxLat.toFixed(2)}°N, {Math.abs(approxLng).toFixed(2)}°W
      </span>
    );
  }

  return <span className="text-sm text-gray-400">Location approximate</span>;
}
