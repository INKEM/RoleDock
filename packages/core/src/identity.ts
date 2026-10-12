/**
 * Trusted session identity model.
 *
 * P1 fixes the shape and the authority rule: identity is issued by the
 * coordinator when a session is bound (sessions.open, P3), never taken from
 * client-supplied fields. SDK operations that need an actor resolve it from
 * this binding; a role_id appearing in request input is a target or a
 * declaration, never an authorization source.
 *
 * sessions.open lands in P3; until then no API can mint one of these, which
 * is itself the P1 guarantee: nothing can hold a session identity yet.
 */
export interface TrustedIdentity {
  readonly workspaceId: string;
  readonly sessionId: string;
  /** Present for role-bound sessions (primary or request branch). */
  readonly instanceId?: string;
  readonly roleId?: string;
}
