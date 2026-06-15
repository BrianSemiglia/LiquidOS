//
//  LiquidOSRecoveryUITests.swift
//
//  TODO: XCUITest for the crash-recovery restart loop — the one part of the
//  feature that lives in the app (LiquidOSApp.swift) and can't be exercised by
//  the Node probes. Everything below the app is covered by
//  skills/testing/scripts/probe-crash-recovery.mjs; this would cover the app
//  noticing the server died, running recovery attempts, and restarting until
//  the workspace boots clean.
//
//  Not implemented: XCUITest needs full Xcode (`xcodebuild test`) and a UI Test
//  target — the repo builds the app with Command Line Tools (`xcrun swiftc`),
//  which can't run it. Wire this up in an environment with Xcode.
//
//  (The prompt contract — that the server dispatches the right recovery
//  prompt — is already covered headlessly by
//  skills/testing/scripts/probe-crash-recovery.mjs. This UI test is only for the
//  app-side loop the Node harness can't drive.)
//
//  Sketch of the test:
//    - Launch the built bundle: XCUIApplication(url: .../mac-app/build/LiquidOS.app)
//    - Force the deterministic stub: launchEnvironment["LIQUIDOS_AGENT"] = "crash-repair-stub"
//    - Point it at a temp workspace with a component or two.
//    - Induce a crash generically (write .crash-report.json + kill the serving
//      process) — do not depend on how a crash arises in the harness.
//    - Assert the workspace comes back up and stays up (the app noticed the
//      crash, ran recovery, and restarted) — not anything component-specific.
//
