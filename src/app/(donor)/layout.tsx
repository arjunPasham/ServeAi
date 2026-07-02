import { InactivityGuard } from '@/components/shared/InactivityGuard';

export default function DonorLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <InactivityGuard />
      {children}
    </>
  );
}
