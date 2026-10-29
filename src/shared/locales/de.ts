import type { en } from './en.js'

export const de = {
  errorNetwork: 'Verbindung fehlgeschlagen. Prüfen Sie das Netzwerk und versuchen Sie es erneut.',
  errorRateLimited: 'Zu viele Versuche. Versuchen Sie es in etwa {seconds} Sekunden erneut.',
  errorUnauthorized: 'Ihre Sitzung ist abgelaufen. Melden Sie sich erneut an.',
  errorServiceUnavailable:
    'Der Dienst ist vorübergehend nicht verfügbar. Versuchen Sie es später erneut.',
  errorGeneric: 'Der Vorgang konnte nicht abgeschlossen werden. Versuchen Sie es erneut.',
  accountLoginDisabled:
    'Die manuelle Kontoanmeldung ist deaktiviert. Laden Sie die Seite neu, um die native Anmeldung zu verwenden.',
  settingsLoginConfiguration: 'Anmeldeeinstellungen',
  settingsManualDescription:
    'Autorisieren Sie in einem neuen Tab und fügen Sie dann die Rückrufadresse ein.',
  settingsManualAccountLogin: 'DeepSeek-Konto aus der Ferne anmelden',
  settingsManualConfigUnavailable: 'Die Anmeldeeinstellungen sind vorübergehend nicht verfügbar.',
  settingsManualUnavailable:
    'Die manuelle Kontoanmeldung ist in dieser DSH-Umgebung nicht verfügbar.',
  settingsManualSaveFailed:
    'Diese Einstellung konnte nicht gespeichert werden. Prüfen Sie den aktuellen Wert und versuchen Sie es erneut.',
  settingsSaving: 'Wird gespeichert…',
  settingsRetry: 'Erneut versuchen',
  accountLoginTitle: 'Bei DeepSeek anmelden',
  accountLoginStepOpen: 'Melden Sie sich in einem neuen Tab bei DeepSeek an.',
  accountLoginStepCopy:
    'Kopieren Sie nach der Autorisierung die vollständige Adresse und fügen Sie sie hier ein.',
  accountLoginCallbackLabel: 'Vollständige Rückrufadresse',
  accountLoginCallbackHint:
    'Ein Verbindungsfehler oder 404 nach der Autorisierung ist normal. Kopieren Sie die vollständige Adresse.',
  accountLoginOpen: 'Anmeldeseite öffnen',
  accountLoginConfirm: 'Anmeldung bestätigen',
  accountLoginCancel: 'Abbrechen',
  accountLoginUseApiKey: 'API-Schlüssel verwenden',
  accountLoginClose: 'Schließen',
  accountLoginRetry: 'Neu beginnen',
  accountLoginReopen: 'Autorisierungsseite erneut öffnen',
  accountLoginPopupBlocked: 'Der neue Tab wurde blockiert.',
  accountLoginInitializing: 'Autorisierung wird vorbereitet…',
  accountLoginWaiting: 'Die Autorisierung ist höchstens 10 Minuten gültig.',
  accountLoginExchanging: 'Anmeldung wird abgeschlossen…',
  accountLoginInvalidCallback:
    'Diese Rückrufadresse passt nicht zur aktuellen Autorisierung. Kopieren Sie die vollständige Adresse mit code und state aus dem neuesten Autorisierungstab.',
  accountLoginExpired: 'Diese Autorisierung ist abgelaufen. Beginnen Sie erneut.',
  accountLoginMismatch:
    'Diese Autorisierung ist in dieser Sitzung nicht mehr verfügbar. Schließen Sie den Dialog und beginnen Sie erneut.',
  accountLoginBusy:
    'Eine andere Autorisierung läuft bereits. Beenden oder stornieren Sie sie, bevor Sie erneut beginnen.',
  accountLoginUnavailable: 'Diese DSH-Version bietet keine kompatible Kontoanmeldung.',
  accountLoginFailed:
    'Die Autorisierung konnte nicht abgeschlossen werden. Beginnen Sie erneut und senden Sie die Adresse aus dem neuen Tab.',
  accountLoginNoResponse:
    'Die DeepSeek-Plattform hat nicht geantwortet. Prüfen Sie die Netzwerkverbindung des DSH-Servers und beginnen Sie erneut.',
  loginInitialTitle: 'Anmelden',
  loginInitialLoading: 'Anmeldestatus wird geprüft…',
  loginSetupTitle: 'Richten Sie zuerst Ihr Konto ein',
  loginSetupDescription:
    'Führen Sie diesen Befehl in einem Terminal auf dem DSH-Server aus und erstellen Sie auf Aufforderung einen Benutzernamen und ein Passwort. Über die Webseite kann das Konto nicht erstellt werden.',
  loginSetupCopy: 'Befehl kopieren',
  loginSetupRecheck: 'Einrichtung abgeschlossen',
  loginSetupCopied: 'Befehl kopiert.',
  loginSetupCopyFallback: 'Markieren Sie den Befehl und kopieren Sie ihn manuell.',
  loginSetupNotFound:
    'Kein Konto gefunden. Prüfen Sie, ob der Befehl dieses Profil verwendet hat, und versuchen Sie es erneut.',
  loginTitle: 'Anmelden',
  loginUsername: 'Benutzername',
  loginPassword: 'Passwort',
  loginContinue: 'Weiter',
  loginMfaTitle: 'Zweiten Faktor bestätigen',
  loginMfaDescription:
    'Geben Sie den sechsstelligen Code Ihrer Authenticator-App oder einen einmaligen Ersatzcode ein. Diese Prüfung läuft nach fünf Minuten ab.',
  loginMfaCode: 'Bestätigungscode oder Ersatzcode',
  loginMfaSubmit: 'Bestätigen und anmelden',
  loginBackToPassword: 'Zurück zur Passwortanmeldung',
  loginMfaExhausted:
    'Alle Bestätigungsversuche sind aufgebraucht. Geben Sie Ihr Passwort erneut ein.',
  loginBindingTitle: 'Authenticator-App verbinden',
  loginBindingDescription:
    'Scannen Sie den QR-Code mit Ihrer Authenticator-App oder geben Sie den geheimen Schlüssel unten ein. Nach der Bestätigung erscheinen zehn einmalige Ersatzcodes und Sie müssen sich erneut anmelden.',
  loginBindingQrAlt: 'QR-Code zur Authenticator-Einrichtung',
  loginBindingManualSecret: 'Geheimer Schlüssel zur manuellen Eingabe',
  loginBindingCode: 'Sechsstelliger Code der Authenticator-App',
  loginBindingConfirm: 'Einrichtung bestätigen',
  loginBindingRestart: 'Erneut anmelden',
  loginBindingQrUnavailable:
    'Der QR-Code ist nicht verfügbar. Verwenden Sie den geheimen Schlüssel oben.',
  loginBindingExhausted:
    'Alle Einrichtungsversuche sind aufgebraucht. Geben Sie Ihr Passwort erneut ein.',
  loginBackupTitle: 'Ersatzcodes speichern',
  loginBackupDescription:
    'Diese Codes werden nur einmal angezeigt. Bewahren Sie sie sicher auf; jeder Code ist nur einmal verwendbar. Melden Sie sich nach dem Speichern erneut an.',
  loginBackupSaved: 'Gespeichert; erneut anmelden',
  loginOptionalTitle: 'Konto schützen',
  loginOptionalDescription:
    'In diesem Profil können Sie eine Authenticator-App später verbinden. Eine Verbindung jetzt erhöht den Schutz; sie ist auch in den Sicherheitseinstellungen möglich.',
  loginOptionalBindNow: 'TOTP jetzt verbinden',
  loginOptionalSkip: 'Überspringen und DSH öffnen',
  loginOptionalVerifyTitle: 'Vor der Einrichtung erneut bestätigen',
  loginOptionalVerifyDescription: 'Geben Sie zum Schutz Ihres Kontos Ihr aktuelles Passwort ein.',
  loginOptionalCurrentPassword: 'Aktuelles Passwort',
  loginOptionalStart: 'Einrichtung starten',
  loginOptionalSkipLater: 'Später verbinden und DSH öffnen',
  loginReasonExpired: 'Ihre Sitzung ist abgelaufen. Melden Sie sich erneut an.',
  loginReasonUpdated: 'Die Sicherheitseinstellungen wurden geändert. Melden Sie sich erneut an.',
  loginReasonSignedOut: 'Sie haben sich von dieser Sitzung abgemeldet.',
  loginUnavailableTitle: 'Anmeldung vorübergehend nicht verfügbar',
  loginUnavailableDescription:
    'Der Dienststatus ist nicht verfügbar. Prüfen Sie die Verbindung und versuchen Sie es erneut.',
  loginRetry: 'Erneut prüfen',
  loginErrorInvalidCredentials: 'Benutzername oder Passwort ist falsch. Versuchen Sie es erneut.',
  loginErrorInvalidFactor:
    'Der Bestätigungscode oder Ersatzcode ist falsch. Nach fünf Fehlversuchen müssen Sie Ihr Passwort erneut eingeben.',
  loginErrorChallenge:
    'Diese Prüfung ist abgelaufen. Geben Sie Benutzernamen und Passwort erneut ein.',
  loginErrorUninitialized:
    'Das Konto ist nicht eingerichtet. Führen Sie den Einrichtungsbefehl im Serverterminal aus.',
  settingsClose: 'Schließen',
  settingsCancel: 'Abbrechen',
  settingsOverview: 'Kontoübersicht',
  settingsUsername: 'Benutzername für die DSH-Anmeldung',
  settingsCreatedAt: 'Angemeldet am',
  settingsExpiresAt: 'Sitzung läuft ab am',
  settingsActiveSessions: 'Aktive Sitzungen',
  settingsTotpRequired:
    'TOTP ist laut Konfiguration erforderlich und kann nicht deaktiviert werden.',
  settingsPasswordTitle: 'Passwort',
  settingsSignOutCurrentDescription: 'Diese Sitzung abmelden? Andere Sitzungen bleiben angemeldet.',
  settingsSectionLabel: 'Sicherheit und Anmeldung',
  settingsSectionAria: 'Einstellungen für Sicherheit und Anmeldung',
  settingsTitle: 'Sicherheit und Anmeldung',
  settingsAccountSummary: 'Konto: {username} · TOTP: {totp}',
  settingsTotpEnabled: 'Aktiviert',
  settingsTotpNotBound: 'Nicht verbunden',
  settingsLoading: 'Kontostatus wird geladen…',
  settingsChangePassword: 'Passwort ändern',
  settingsBindTotp: 'TOTP aktivieren',
  settingsRebindTotp: 'TOTP neu verbinden',
  settingsSessions: 'Sitzungsverwaltung',
  settingsPasswordMismatch: 'Die neuen Passwörter stimmen nicht überein.',
  settingsPasswordDescription: 'Nach dieser Änderung müssen sich alle Geräte erneut anmelden.',
  settingsCurrentPassword: 'Aktuelles Passwort',
  settingsCurrentCode: 'Aktueller Bestätigungscode oder Ersatzcode',
  settingsNewPassword: 'Neues Passwort',
  settingsConfirmPassword: 'Neues Passwort bestätigen',
  settingsSavePassword: 'Neues Passwort speichern',
  settingsBindDescription:
    'Geben Sie Ihre aktuellen Zugangsdaten ein. Nach dem Verbinden der neuen Authenticator-App müssen sich alle Geräte erneut anmelden.',
  settingsStartBinding: 'Einrichtung starten',
  settingsDisableTotp: 'TOTP deaktivieren',
  settingsDisableDescription:
    'Nach dem Deaktivieren von TOTP müssen sich alle Geräte erneut anmelden.',
  settingsScanQr: 'QR-Code scannen',
  settingsQrAlt: 'QR-Code zur Authenticator-Einrichtung',
  settingsQrUnavailable:
    'Der QR-Code ist nicht verfügbar. Verwenden Sie den geheimen Schlüssel unten.',
  settingsQrLoading:
    'QR-Code wird erstellt; Sie können auch den geheimen Schlüssel unten verwenden.',
  settingsManualSecret: 'Geheimer Schlüssel zur manuellen Eingabe:',
  settingsNewCode: 'Sechsstelliger Code der neuen Authenticator-App',
  settingsConfirmBinding: 'Einrichtung bestätigen',
  settingsRestartBinding: 'Neu beginnen',
  settingsSignOutCurrent: 'Diese Sitzung abmelden',
  settingsSignOutAll: 'Alle Sitzungen abmelden',
  settingsSignOutAllDescription:
    'Geben Sie Ihre aktuellen Zugangsdaten ein. Alle Sitzungen, einschließlich dieser, und alle offenen Verbindungen werden widerrufen.',
  settingsOldBackupInvalid: 'Ihre bisherigen Ersatzcodes funktionieren danach nicht mehr.',
  settingsCopyAll: 'Alle kopieren',
  settingsBackupCopied: 'Ersatzcodes kopiert.',
  settingsBackupCopyFailed:
    'Kopieren fehlgeschlagen. Markieren Sie die Codes und kopieren Sie sie manuell.',
  settingsBackupTitle: 'Ersatzcodes speichern',
  settingsBackupDescription:
    'Diese Codes werden nur einmal angezeigt. Bewahren Sie sie sicher auf; jeder Code ist nur einmal verwendbar.',
  settingsBackupSaved: 'Gespeichert; erneut anmelden',
  settingsErrorInvalidCredentials: 'Das aktuelle Passwort ist falsch.',
  settingsErrorInvalidFactor: 'Der aktuelle Bestätigungscode oder Ersatzcode ist falsch.',
  settingsErrorInvalidInput:
    'Die Eingabe ist ungültig. Das Passwort muss die Längenvorgaben des Servers erfüllen.',
  settingsErrorChallenge:
    'Die Einrichtungsprüfung ist abgelaufen. Starten Sie die Einrichtung erneut.',
  settingsErrorTotpRequired:
    'Dieses Profil erfordert TOTP; es kann daher nicht deaktiviert werden.',
} as const satisfies { [Key in keyof typeof en]: string }
