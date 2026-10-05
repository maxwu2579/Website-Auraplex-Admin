/** The protected Admin workspace; `/` and `/admin` both redirect here. */
export const ADMIN_HOME_PATH = '/admin/upload';

/**
 * Public page shown after logout. It is deliberately not the Admin entry:
 * returning a signed-out browser to a protected route would start a Keycloak
 * login again immediately.
 */
export const ADMIN_SIGNED_OUT_PATH = '/signed-out';
