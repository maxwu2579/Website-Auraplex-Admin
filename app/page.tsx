import { redirect } from 'next/navigation';
import { ADMIN_HOME_PATH } from '@/lib/admin/admin-routes';

export default function RootPage() {
  redirect(ADMIN_HOME_PATH);
}
