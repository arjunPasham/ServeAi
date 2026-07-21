import { redirect } from 'next/navigation';

// Pivot: the donor surface became the merchant app. Old bookmarks land here.
export default function DonorDashboardRedirect() {
  redirect('/merchant/dashboard');
}
