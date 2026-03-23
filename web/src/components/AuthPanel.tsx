import { useEffect, useRef, useState } from 'react'

type AuthMode = 'sign-in' | 'sign-up'

type AuthPanelProps = {
  isSupabaseConfigured: boolean
  isAuthLoading: boolean
  isAuthSubmitting: boolean
  authMode: AuthMode
  email: string
  password: string
  authMessage: string | null
  cloudStatus: string | null
  userEmail: string | null
  onEmailChange: (value: string) => void
  onPasswordChange: (value: string) => void
  onAuthModeChange: (mode: AuthMode) => void
  onSubmit: () => void
  onSignOut: () => void
}

export function AuthPanel({
  isSupabaseConfigured,
  isAuthLoading,
  isAuthSubmitting,
  authMode,
  email,
  password,
  authMessage,
  cloudStatus,
  userEmail,
  onEmailChange,
  onPasswordChange,
  onAuthModeChange,
  onSubmit,
  onSignOut,
}: AuthPanelProps) {
  const [isOpen, setIsOpen] = useState(false)
  const panelRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (
        panelRef.current &&
        event.target instanceof Node &&
        !panelRef.current.contains(event.target)
      ) {
        setIsOpen(false)
      }
    }

    document.addEventListener('pointerdown', handlePointerDown)

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
    }
  }, [])

  const triggerLabel = userEmail ? `Hi ${userEmail}` : 'Sign in'

  return (
    <div className="auth-panel" ref={panelRef}>
      <button
        className="ghost-button auth-trigger"
        type="button"
        onClick={() => setIsOpen((current) => !current)}
      >
        {triggerLabel}
      </button>

      {isOpen ? (
        <section className="auth-popover">
          {!isSupabaseConfigured ? (
            <>
              <div className="auth-popover-header">
                <div>
                  <p className="panel-kicker">Account</p>
                  <h3>Cloud sync unavailable</h3>
                </div>
              </div>
              <p className="auth-copy auth-copy-compact">
                Add Supabase env vars to enable sign-in and cloud saves.
              </p>
              <div className="auth-status-chip">Waiting for Supabase env vars</div>
            </>
          ) : userEmail ? (
            <>
              <div className="auth-popover-header">
                <div>
                  <p className="panel-kicker">Account</p>
                  <h3>{userEmail}</h3>
                </div>
                <button className="ghost-button" type="button" onClick={onSignOut}>
                  Sign out
                </button>
              </div>

              <div className="auth-status-row">
                <div className="auth-status-chip auth-status-chip-live">
                  {cloudStatus ?? 'Cloud sync connected'}
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="auth-popover-header">
                <div>
                  <p className="panel-kicker">Account</p>
                  <h3>{authMode === 'sign-up' ? 'Create account' : 'Sign in'}</h3>
                </div>
              </div>

              <div className="auth-toggle auth-toggle-block">
                <button
                  className={authMode === 'sign-in' ? 'auth-toggle-active' : undefined}
                  type="button"
                  onClick={() => onAuthModeChange('sign-in')}
                >
                  Sign in
                </button>
                <button
                  className={authMode === 'sign-up' ? 'auth-toggle-active' : undefined}
                  type="button"
                  onClick={() => onAuthModeChange('sign-up')}
                >
                  Create account
                </button>
              </div>

              <div className="auth-form">
                <label className="field">
                  <span className="sr-only">Email</span>
                  <input
                    autoComplete="email"
                    placeholder="Email"
                    type="email"
                    value={email}
                    onChange={(event) => onEmailChange(event.target.value)}
                  />
                </label>

                <label className="field">
                  <span className="sr-only">Password</span>
                  <input
                    autoComplete={
                      authMode === 'sign-up' ? 'new-password' : 'current-password'
                    }
                    placeholder="Password"
                    type="password"
                    value={password}
                    onChange={(event) => onPasswordChange(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        onSubmit()
                      }
                    }}
                  />
                </label>

                <button
                  className="ghost-button auth-submit"
                  type="button"
                  onClick={onSubmit}
                  disabled={isAuthLoading || isAuthSubmitting}
                >
                  {isAuthLoading || isAuthSubmitting
                    ? 'Working...'
                    : authMode === 'sign-up'
                      ? 'Create account'
                      : 'Sign in'}
                </button>
              </div>

              {authMessage ? (
                <div className="auth-status-row">
                  <div className="auth-status-chip">{authMessage}</div>
                </div>
              ) : null}
            </>
          )}
        </section>
      ) : null}
    </div>
  )
}
