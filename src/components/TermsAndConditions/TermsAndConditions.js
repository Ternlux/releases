import React, { useState } from 'react';
import {
  Box,
  Typography,
  Button,
  Paper,
  Checkbox,
  FormControlLabel,
  Divider,
  Alert,
  Link,
  Card,
  CardContent,
} from '@mui/material';
import {
  CheckCircle,
  InsightsOutlined,
  ShieldOutlined,
  OpenInNew,
} from '@mui/icons-material';

const STORAGE_KEY_ACCEPTED = 'ternlux_terms_accepted';
const STORAGE_KEY_VERSION = 'ternlux_terms_version';
const STORAGE_KEY_ANALYTICS = 'ternlux_analytics_opt_in';
// Acceptance of an older version does not count: App.js shows this screen
// again whenever the recorded version differs, so bump it for material changes.
export const TERMS_VERSION = '1.1';

// The published documents. The copy in the scroll area is a snapshot taken at
// this version; these are the live ones, and the agreement is to them.
const TERMS_URL = 'https://www.ternlux.com/terms-and-conditions/';
const PRIVACY_URL = 'https://www.ternlux.com/privacy-policy/';

/**
 * A link out to a published document.
 *
 * `target="_blank"` is what carries it out of the app: Electron's window-open
 * handler denies the in-app navigation and hands the URL to the system browser
 * (see setWindowOpenHandler in public/electron.js), so the consent screen is
 * never navigated away from.
 *
 * The click is also stopped from propagating — these links sit inside a
 * checkbox's label, and a label click toggles the checkbox. Reading the terms
 * would otherwise agree to them on your behalf.
 */
const DocLink = ({ href, children }) => (
  <Link
    href={href}
    target="_blank"
    rel="noreferrer"
    onClick={(e) => e.stopPropagation()}
    sx={{
      fontWeight: 700,
      display: 'inline-flex',
      alignItems: 'center',
      gap: 0.35,
      verticalAlign: 'baseline',
    }}
  >
    {children}
    <OpenInNew sx={{ fontSize: 13 }} />
  </Link>
);

/**
 * Typography for the terms snapshot.
 *
 * The markup below is plain HTML rather than MUI components — it is a legal
 * document, not UI — so the styling is scoped here as descendant selectors on
 * the wrapper. Class names keep the `df-` prefix used by the published
 * TERMS_OF_SERVICE.html so the two stay recognisably the same document.
 */
const termsTypographySx = {
  color: 'text.primary',
  fontSize: 14,
  lineHeight: 1.65,

  '& h1': {
    fontSize: 20,
    fontWeight: 800,
    letterSpacing: '-0.01em',
    m: 0,
    mb: 0.75,
  },
  '& h2': {
    fontSize: 15,
    fontWeight: 700,
    letterSpacing: '-0.005em',
    mt: 3.5,
    mb: 1,
    pb: 0.75,
    borderBottom: '1px solid',
    borderColor: 'divider',
  },
  '& p': {
    m: 0,
    mb: 1.5,
  },
  '& p:last-child': { mb: 0 },

  // Publication date under the title.
  '& .df-meta': {
    fontSize: 12.5,
    color: 'text.secondary',
    mb: 2.5,
  },

  // The "read carefully" notice. Called out because it is the paragraph that
  // points at the disclaimers, the arbitration clause and the data-loss risk.
  '& .df-callout': {
    p: 1.75,
    mb: 2,
    borderRadius: 1.5,
    border: '1px solid',
    borderColor: 'warning.light',
    bgcolor: 'warning.50',
    fontSize: 13.5,
  },

  // The all-caps disclaimer and liability paragraphs. Caps text runs together
  // without a little extra tracking and leading.
  '& .df-caps': {
    fontSize: 13,
    lineHeight: 1.75,
    letterSpacing: '0.01em',
  },

  // "X means Y" definitions in Section 1.
  '& .df-term': { fontWeight: 700 },
};

/**
 * The terms snapshot, as displayed in the scroll area.
 *
 * Wording is verbatim from TERMS_OF_SERVICE version 1.1 (last updated
 * October 27, 2026), the revision for the open-source release. Only the structure is ours: headings, paragraph breaks and
 * the repair of page-break artifacts from the source export (words split
 * across a page boundary, sentences run together where one page ended and the
 * next began). No term has been added, removed or reworded.
 */
const TermsOfServiceBody = () => (
  <Box sx={termsTypographySx}>
    <h1>Ternlux — Terms of Service</h1>
    <p className="df-meta">
      <strong>Last updated:</strong> October 27, 2026
    </p>

    <p>
      These Terms of Service (“Terms”) are a binding agreement between Ternlux Inc., a
      California corporation (“Ternlux,” “we,” “us”), and the organization on whose behalf the
      Services are accessed (“Customer,” “you”). They govern your access to and use of the
      Ternlux desktop application (the “Desktop App”) and, if and when you access it, the
      Ternlux hosted cloud service (the “Cloud Service,” and together with the Desktop App and
      all related plugins, software, and documentation, the “Services”).
    </p>
    <p>
      These Terms govern your use of Official Builds of the Desktop App and of the services
      Ternlux operates. They do not limit any right you have under the open-source license of the
      Open-Source Software (Section 5).
    </p>

    <p className="df-callout">
      PLEASE READ CAREFULLY. These Terms contain disclaimers of warranties, limitations of
      liability, an assumption of risk regarding automated and AI-generated operations that can
      modify or destroy your data, a mandatory arbitration provision, and a class-action waiver.
    </p>

    <p>
      By downloading, installing, accessing, or using the Services, you agree to be bound by
      them. If you do not agree, do not use the Services.
    </p>

    <h2>1. Definitions</h2>
    <p>
      <span className="df-term">“AI Provider”</span> means any third-party large-language-model,
      embedding, or other AI service used in connection with the Services (e.g., OpenAI,
      Anthropic, Google), whether accessed through your own API key (Desktop App) or provisioned
      by Ternlux (Cloud Service).
    </p>
    <p>
      <span className="df-term">“AI Output”</span> means any code, query, transformation, text,
      or other output generated by an AI Provider in response to prompts.
    </p>
    <p>
      <span className="df-term">“Connected Systems”</span> means the databases, data warehouses,
      vector stores, cloud storage, spreadsheets, APIs, and other third-party systems you
      configure the Services to access.
    </p>
    <p>
      <span className="df-term">“Customer Content”</span> means the data, workflows, queries,
      schemas, files, prompts, chat history, and results you submit to, process through, or
      generate with the Services.
    </p>
    <p>
      <span className="df-term">“Cloud Credits”</span> means the variable, backend-metered
      consumption units used to access compute and AI functionality within the Cloud Service.
    </p>
    <p>
      <span className="df-term">“Desktop App”</span> means the locally installed Ternlux
      application.
    </p>
    <p>
      <span className="df-term">“Official Build”</span> means a Desktop App binary that Ternlux
      builds, signs, and distributes.
    </p>
    <p>
      <span className="df-term">“Open-Source Software”</span> means the source code of the
      Desktop App and the Plugins that Ternlux publishes under an open-source license, currently
      the Apache License, Version 2.0, at github.com/Ternlux.
    </p>
    <p>
      <span className="df-term">“Plugins”</span> means connectors and AI “skills” for the Desktop
      App, whether bundled with it, downloaded from the Ternlux catalog, or built by you or others.
    </p>

    <h2>2. Structure of these Terms</h2>
    <p>
      The Services currently consist of the free Desktop App. Ternlux may also offer the paid,
      hosted Cloud Service. Provisions of these Terms expressly designated “Cloud only” apply
      solely to your use of the Cloud Service and take effect only if and when you access it.
      General provisions apply to all Services. The Cloud Service, or particular Cloud features,
      may not be available at the time you accept these Terms.
    </p>
    <p>
      Your use of the Services is also governed by the Ternlux Privacy Policy, the Acceptable
      Use Policy (“AUP”), and, for the Cloud Service, the Data Processing Addendum (“DPA”), each
      incorporated by reference.
    </p>
    <p>
      In the event of a conflict among these documents, the following order of precedence
      governs, from highest to lowest: (a) with respect to the Open-Source Software, its
      open-source license; (b) with respect to the processing of personal data, the DPA; (c)
      these Terms; (d) the AUP; and (e) the Privacy Policy. In all other respects the
      documents are intended to be read together, and a term in one document that provides
      greater specificity on a subject controls over a more general term in another rather than
      creating a conflict.
    </p>

    <h2>3. Eligibility</h2>
    <p>
      The Services are offered solely to businesses and professional users for business purposes.
      They are not directed to consumers and are not intended for, or directed to, minors. By
      accepting these Terms you represent that you are accessing the Services on behalf of an
      organization and for business purposes, and not as a consumer.
    </p>
    <p>
      The individual accepting these Terms represents that they are authorized to bind the
      Customer organization. If you invite or grant access to others under your account, you are
      responsible for their compliance with these Terms.
    </p>
    <p>
      Nothing in this Section limits who may use the Open-Source Software under its license.
    </p>

    <h2>4. Accounts and registration</h2>
    <p>
      An account is optional for the Desktop App, including all Plugins. An account is required
      for the Cloud Service and for any other feature that we identify as requiring one. You may
      register with a name, email address, and
      password, or via a supported third-party identity provider, in which case you authorize us
      to receive the identity information that provider returns.
    </p>
    <p>
      You are responsible for safeguarding your credentials, enabling available security
      controls, and for all activity occurring under your account. Notify us promptly of any
      unauthorized use.
    </p>

    <h2>5. Desktop App and open-source license</h2>
    <p>
      The Desktop App’s source code and the Plugins are Open-Source Software, licensed under the
      Apache License, Version 2.0 (the “Open-Source License”). A copy is included with the source
      code and with each Official Build. Your rights to use, copy, modify, and distribute the
      Open-Source Software are governed solely by the Open-Source License, and nothing in these
      Terms restricts them. If these Terms conflict with the Open-Source License with respect to
      the Open-Source Software, the Open-Source License controls. The Desktop App is currently
      provided free of charge.
    </p>
    <p>
      The Desktop App runs on your machine. It builds and executes data workflows locally and
      against Connected Systems you configure. Except for the limited server-side functions
      described in the Privacy Policy, Ternlux does not receive, process, or store your workflow
      data when you use the Desktop App.
    </p>
    <p>
      Builds of the Desktop App made by you or by third parties (“Unofficial Builds”) are not
      provided by Ternlux. Ternlux is not responsible for them, and they may not receive updates
      or may behave differently from Official Builds.
    </p>
    <p>
      The Open-Source License does not grant permission to use Ternlux’s trade names,
      trademarks, service marks, or logos, except as required for reasonable and customary use in
      describing the origin of the software. See the Ternlux Trademark Policy.
    </p>
    <p>
      Official Builds check for updates automatically on launch and periodically while running,
      and downloads available updates automatically from Ternlux’s software-distribution
      provider. When an update has been downloaded you may choose to restart immediately or
      later; if you defer, the update installs automatically when you next quit the application.
      Updates may add, modify, or remove features and may change how the Desktop App operates,
      and this Section applies to the Desktop App as updated. There is
      currently no in-app setting to disable update checks; if you do not wish to receive
      automatic updates, do not install or continue to use the Desktop App. Ternlux is not
      obligated to provide updates, support, or maintenance for any prior version.
    </p>
    <p>
      The Services are built on and bundle third-party open-source software. Such components are
      licensed to you under their own respective license terms, which control over these Terms
      with respect to those components.
    </p>
    <p>
      Installing certain Plugins or skills causes the Desktop App to install and run components
      on your machine. You authorize the Desktop App to install and execute such components
      locally as part of the functionality you invoke.
    </p>

    <h2>6. Ternlux Cloud subscription license (Cloud only)</h2>
    <p>
      Subject to these Terms, Ternlux grants you a limited, non-exclusive, non-transferable,
      non-sublicensable right to access and use the Cloud Service during your subscription term
      for your internal business purposes. The Cloud Service is hosted and operated by Ternlux.
    </p>
    <p>
      Ternlux may offer the ability to migrate your locally stored work to the Cloud Service.
      Migration occurs only if you expressly elect it; Ternlux does not migrate anything
      automatically. If you elect migration, your workflows and execution history are copied from
      your device to Ternlux’s cloud infrastructure, and from that point they are Customer
      Content hosted and processed by Ternlux under these Terms and the DPA rather than handled
      locally. Your Connected System credentials and OAuth tokens are not migrated. Ternlux does
      not decrypt or transmit the secrets stored in your operating system’s secure storage, and
      you must separately re-authorize each Connected System within the Cloud Service, including
      through Ternlux’s own OAuth client where applicable; only credentials and tokens newly
      issued through that re-authorization are stored server-side under Section 9. Electing
      migration constitutes your acceptance of the Cloud Service terms, including this Section,
      the billing terms in Section 12, and the DPA.
    </p>

    <h2>7. Plugins</h2>
    <p>
      Plugins are Open-Source Software. Plugins bundled with the Desktop App or downloaded from
      the Ternlux catalog are authored by Ternlux, and no account is required to install or use
      them. You may also install Plugins from other sources, including Plugins you or others build
      or modify (“Third-Party Plugins”). Ternlux does not provide, review, or support Third-Party
      Plugins. They run with the same access to your computer and Connected Systems as the
      Desktop App, and you use them at your own risk. If Ternlux later operates a marketplace for
      Third-Party Plugins, additional terms will apply.
    </p>

    <h2>8. Third-party services and Connected Systems</h2>
    <p>
      The Services act on your instructions to transmit data to, and exchange data with, AI
      Providers and Connected Systems that you choose and configure. You are solely responsible
      for those choices, for maintaining the rights and permissions necessary to connect and use
      those systems, and for compliance with the terms, acceptable-use policies, and rate limits
      of every third party you connect.
    </p>
    <p>
      In the Desktop App, you supply your own AI Provider API keys and contract directly with
      those providers. When you invoke an AI feature, the Desktop App transmits to the AI
      Provider you select your prompts, the relevant conversation history, inferred schema and
      samples of your data, and, where you ask the chat assistant a question that requires live
      data, the results of the read queries, API calls, and generated code the assistant runs on
      your behalf, which may include substantial portions of your data rather than a limited
      sample. You direct these transmissions by choosing to use the applicable feature, and your
      use of those providers is governed by their terms and privacy policies.
    </p>
    <p>
      The Desktop App is free, but your use of AI Providers and Connected Systems may incur
      charges billed to you directly by those third parties (including AI token charges and
      third-party fees). You are solely responsible for all such charges. Ternlux is not
      responsible for third-party fees or for third-party outages, deprecations, or API changes
      that affect your workflows.
    </p>
    <p>
      Integration with a third party does not imply any partnership with, or endorsement by, that
      third party.
    </p>

    <h2>9. Credentials and secrets</h2>
    <p>
      Secrets you enter through the Desktop App’s designated credential fields (including AI
      Provider API keys, database passwords, API tokens, and OAuth tokens) are stored only on
      your device, encrypted using your operating system’s secure storage, and are decrypted only
      when a connection or AI call runs. Saved workflow files contain placeholders rather than
      actual secrets.
    </p>
    <p>
      In the Cloud Service, to enable automated and scheduled workflow execution, Ternlux stores
      your Connected System credentials and OAuth tokens in encrypted form on its cloud
      infrastructure. By providing credentials or authenticating via OAuth, you expressly
      authorize Ternlux to act as your agent to access, read, write, and transfer data among your
      Connected Systems solely to execute the workflows you configure. You represent and warrant
      that you are permitted to grant that access and that doing so does not violate any
      agreement with, or the terms of, any employer, vendor, or other third party. You are solely
      responsible for the scope of the permissions you grant and are encouraged to grant scoped
      or read-only access where possible; Ternlux disclaims responsibility for over-broad grants
      you choose to make.
    </p>
    <p>
      You acknowledge that scheduled, webhook-triggered, and otherwise automated Cloud workflows
      will use your stored credentials to access your Connected Systems autonomously, including
      when you are not logged in or otherwise present. Ternlux operates entirely server-side and
      does not access, and has no agent on, your local computer.
    </p>
    <p>
      Ternlux’s secure handling covers only credentials entered through the designated credential
      fields. Ternlux cannot prevent you from placing secrets where they do not belong. You must
      not hard-code secrets into unsecured fields or disclose them to AI features, and Ternlux
      disclaims all responsibility for secrets handled in this manner.
    </p>
    <p>
      You may revoke access or disconnect a Connected System at any time. On revocation,
      disconnection, or account closure, Ternlux deletes the associated stored credentials and
      OAuth tokens; scheduled workflows relying on them will thereafter fail.
    </p>

    <h2>10. AI features and AI Output</h2>
    <p>
      The Services use AI. AI Output is non-deterministic: the same prompt may produce different
      results on different runs. AI Output may be incorrect, incomplete, biased, “hallucinated,”
      non-functional, or unexpected, and may generate code or operations that modify or destroy
      data.
    </p>
    <p>
      You are solely responsible for reviewing, testing, and validating all AI Output before
      relying on or executing it, including AI-generated SQL, JavaScript, Python, and other code.
      This responsibility applies regardless of the source of the prompt, and applies even where
      Ternlux’s templates contain errors, flawed logic, or produce unintended results. The
      Services present a preview/approval step for certain operations; your decision to proceed
      is your own. AI Output is assistance, not professional advice, and is not a guaranteed or
      verified result.
    </p>
    <p>
      Your use of AI features is subject to the acceptable-use and usage policies of the
      applicable AI Providers, which are passed through to you and which you agree to comply
      with.
    </p>

    <h2>11. Code execution and assumption of data-loss risk</h2>
    <p>
      The Services build and execute operations against your own data and Connected Systems.
      These operations include in-place UPDATE, DELETE, and ALTER operations and may drop or
      recreate tables or collections, and they include AI-authored and user-directed SQL,
      JavaScript, and Python. In the Desktop App these operations run on your machine; in the
      Cloud Service they run in Ternlux-managed, sandboxed compute (Cloud only).
    </p>
    <p>
      You acknowledge and accept that AI-generated and user-directed operations can modify,
      corrupt, or permanently destroy data in your Connected Systems, and that such loss may be
      irreversible. You are solely responsible for reviewing operations before running them and
      for maintaining independent, current backups of your systems of record. Ternlux does not
      act as, and is not a substitute for, your backup or disaster-recovery solution.
    </p>
    <p>
      Ternlux does not warrant that its sandboxing or tenant isolation is free from
      vulnerability. Ternlux may impose and change limits on runtime, memory, network egress, and
      concurrency. You must not attempt to circumvent isolation controls. Ternlux disclaims
      liability for the outcomes of your own or AI-generated code logic.
    </p>

    <h2>12. Subscriptions, Cloud Credits, and billing (Cloud only)</h2>
    <p>
      The Cloud Service is sold on a subscription basis. A base subscription fee grants an
      allocation of Cloud Credits usable for both cloud compute and AI model usage. A Cloud
      Credit is not a fixed dollar value, and is not stored value, currency, a gift card, or a
      prepaid instrument. It is a limited license to consume Ternlux Services. Ternlux calculates
      the Credit cost of each action on its backend based on the actual cost to perform it,
      including the compute consumed and the AI model used; the cost per Credit varies by model
      and provider and may change as underlying costs change. Ternlux provides a means to view
      your consumption.
    </p>
    <p>
      If Customer disputes any charge or usage measurement in good faith, Customer must notify
      Ternlux in writing within 60 days after the charge is invoiced or the consumption is
      recorded in Customer’s account, whichever is later, and provide reasonable detail. Charges
      and measurements not disputed within that period are final and deemed accepted. Customer
      must timely pay all undisputed amounts, and the parties will work in good faith to resolve
      any disputed amount promptly. Raising a dispute does not by itself entitle Customer to
      withhold undisputed amounts or to a refund of non-refundable fees or consumed Credits under
      this Section 12.
    </p>
    <p>
      Cloud Credits included with a subscription expire at the end of each monthly billing cycle
      and do not roll over. Separately purchased add-on Credits are subject to the terms
      disclosed at purchase. All fees and all Credit purchases are final and non-refundable.
    </p>
    <p>
      If you opt in to overage billing, you are liable for all charges incurred beyond your base
      subscription. You are responsible for consumption caused by your own workflows, including
      runaway consumption from infinite loops, large backfills, or similar behavior.
    </p>
    <p>
      Subscriptions renew automatically for successive terms unless cancelled. Before you are
      charged, we will disclose the price, billing frequency, and renewal terms and obtain your
      affirmative consent, and we will send a post-purchase confirmation. You may cancel at any
      time through your account; cancellation takes effect at the end of the then-current term,
      and no partial-term refunds are provided.
    </p>
    <p>
      Card payments are processed by Stripe. Ternlux does not store full payment card numbers.
      You authorize us and Stripe to charge your payment method for all applicable fees.
    </p>
    <p>
      We may change fees and Credit rates on prospective notice, effective at the start of the
      next billing cycle; any term you have prepaid will be honored at the prior rate for that
      term.
    </p>
    <p>
      Fees are exclusive of taxes. You are responsible for all taxes. Ternlux will collect such
      taxes where required.
    </p>
    <p>
      We may suspend or downgrade the Cloud Service for non-payment. Improper chargebacks may
      result in suspension and additional remedies.
    </p>
    <p>
      Free trials and promotional credits, where offered, are subject to the specific terms
      disclosed at the time and may expire or convert to paid.
    </p>

    <h2>13. Acceptable use</h2>
    <p>
      Your use of the Services is subject to the AUP, incorporated by reference. Without limiting
      the AUP, you must not: mine cryptocurrency; conduct denial-of-service attacks, network
      scanning, or unauthorized scraping; execute malware or malicious code; attempt to breach
      sandbox or tenant isolation; conduct prompt-injection attacks or jailbreaks against
      connected AI, or attempt to bypass AI safety controls; generate unlawful, infringing, or
      harmful content; impose disproportionate load that degrades the Services for others; or
      conduct unauthorized security testing of the platform. We may monitor for abuse and may
      throttle, suspend, or terminate access, and preserve or disclose information to law
      enforcement where legally required. Violations may result in immediate suspension or
      termination, forfeiture of Credits without refund, and indemnification obligations.
    </p>

    <h2>14. Prohibited data</h2>
    <p>
      The Services are not designed for, and must not be used to submit or process, data subject
      to special regulatory regimes. You must not submit: protected health information subject to
      HIPAA; financial data subject to the Gramm-Leach-Bliley Act; full payment card cardholder
      data subject to PCI-DSS; biometric data; or personal data of children subject to COPPA or
      similar laws.
    </p>
    <p>
      Ternlux makes no representation that the Services meet the requirements of those regimes,
      does not enter into business associate agreements, and disclaims all responsibility for
      prohibited data you submit in breach of this Section. You are solely liable for any such
      submission, and we may suspend or terminate for it.
    </p>

    <h2>15. Teams and seats (Cloud only)</h2>
    <p>
      The Cloud Service may support multi-seat teams that share workflows and data connections.
      The account owner is legally and financially responsible for the actions, data-compliance,
      and Credit consumption of all invited members, warrants authority to bind its organization
      and to invite members, and is responsible for configuring internal permissions using the
      controls Ternlux provides. Sharing a data connection shares access to the underlying
      Connected System. Ternlux is not responsible for what members do with shared data
      internally; the Customer is the single controller for the workspace and handles its
      members’ data-subject requests. Removing a member revokes that member’s access but does not
      delete shared workspace assets. Adding or removing seats mid-cycle does not entitle you to
      a refund.
    </p>
    <p>
      The account owner of record may transfer account ownership to another member by the means
      Ternlux provides or by written request from the owner of record. Where the owner of record
      is unavailable, has departed the organization, or is otherwise unable to make the request,
      Ternlux may transfer ownership on written request from an authorized representative of
      Customer, subject to verification satisfactory to Ternlux. Ternlux may rely conclusively on
      the account owner and administrators of record for all instructions, including seat
      management, ownership transfer, and account closure, and is not responsible for verifying
      internal authority beyond the account of record. If a dispute arises within Customer’s
      organization regarding ownership or control of an account or workspace, Ternlux may, at its
      option, take no action, suspend the account, or maintain the status quo until the dispute
      is resolved to Ternlux’s reasonable satisfaction or by a final order of a court or other
      competent authority. Ternlux will not be liable for any action taken or not taken in
      good-faith reliance on the account of record, and resolution of any such internal dispute
      is solely Customer’s responsibility.
    </p>

    <h2>16. Intellectual property; data ownership; AI Output rights; feedback</h2>
    <p>
      As between the parties, you retain all rights in your Customer Content and the workflows
      you build. You grant Ternlux a limited, worldwide, non-exclusive license to host, process,
      transmit, and display Customer Content solely to provide and support the Services.
    </p>
    <p>
      Ternlux and its licensors own all rights in the Ternlux name, logos, and trademarks, and in
      the Cloud Service, Ternlux’s servers and server-side software, and any software or
      documentation that Ternlux has not published under an open-source license. Rights in the
      Open-Source Software are governed by Section 5. Except for the licenses expressly granted in
      these Terms or the Open-Source License, no rights are granted to you.
    </p>
    <p>
      As between the parties, and subject to the applicable AI Providers’ terms, rights in AI
      Output are assigned to you. Ternlux makes no warranty as to the accuracy, originality, or
      non-infringement of AI Output, and you acknowledge that similar or identical output may be
      generated for other users.
    </p>
    <p>
      Ternlux does not use Customer Content to train its own or its AI sub-processors’ models,
      and (for the Cloud Service) contractually requires its AI sub-processors not to train on
      Customer Content, as further described in the DPA.
    </p>
    <p>
      Ternlux may generate and use aggregated and de-identified data derived from use of the
      Services to operate and improve the Services, provided such data does not identify you or
      any individual.
    </p>
    <p>
      You grant Ternlux a perpetual, irrevocable, royalty-free license to use any feedback or
      suggestions you provide, without restriction. Contributions of code or documentation to
      Ternlux’s open-source repositories are governed by the contribution terms in those
      repositories, not by this paragraph.
    </p>
    <p>
      Ternlux will not use your name or logo as a customer reference without your consent, which
      you may withdraw.
    </p>

    <h2>17. Data protection</h2>
    <p>
      For account, billing, and product-usage data, Ternlux acts as a controller, as described in
      the Privacy Policy. For Customer Content processed in the Cloud Service, Ternlux acts as a
      processor acting on your documented instructions (the workflows you configure), and the DPA
      applies (Cloud only). In the Desktop App, Customer Content is generally handled locally and
      is not received or controlled by Ternlux.
    </p>
    <p>
      You are the controller of Customer Content and warrant that you have all rights, consents,
      notices, and legal bases required to process it through the Services, including under GDPR
      and the CCPA/CPRA as applicable.
    </p>
    <p>
      The Cloud Service is hosted in the United States. There is no EU data-residency option at
      launch. For customers whose data is transferred from the EEA, UK, or Switzerland, the
      transfer mechanisms set out in the DPA apply.
    </p>

    <h2>18. Security, availability, and compliance</h2>
    <p>
      Ternlux maintains commercially reasonable technical and organizational measures appropriate
      to the Services, described (for the Cloud Service) in the DPA, including encryption in
      transit and at rest, access controls, and secrets handling for stored credentials. No
      method of transmission or storage is completely secure, and Ternlux does not guarantee
      absolute security.
    </p>
    <p>
      Ternlux does not currently hold SOC 2 or any comparable third-party security or compliance
      certification. The Services are provided without any certified compliance attestation, and
      nothing in the Services or in Ternlux’s materials should be read to claim or imply
      otherwise.
    </p>
    <p>
      The Cloud Service is provided on an “as-available” basis with no service-level or uptime
      commitment. Ternlux may perform maintenance and may modify or discontinue features. You
      remain responsible for your own systems of record; Ternlux’s backups, if any, are not a
      substitute for yours.
    </p>
    <p>
      Ternlux may offer features or services identified as beta or early-access (“Beta
      Features”). Beta Features are provided “as is” and “as available,” may be changed,
      suspended, or withdrawn at any time without notice, and may be less reliable than generally
      available Services, including a heightened risk of errors, downtime, or loss or corruption
      of data. Ternlux may subject any Beta Feature to separate or additional terms disclosed at
      the time of access, which govern that Beta Feature to the extent of any conflict with these
      Terms. Notwithstanding anything to the contrary, Ternlux’s indemnity in Section 21 does not
      apply to Beta Features, and Ternlux’s total liability arising from Beta Features is subject
      to the limitations in Section 20. Customer should not use Beta Features with production
      data or systems of record for which it does not maintain independent backups.
    </p>

    <h2>19. Disclaimer of warranties</h2>
    <p className="df-caps">
      THE SERVICES, INCLUDING ALL AI OUTPUT, ARE PROVIDED “AS IS” AND “AS AVAILABLE,” WITH ALL
      FAULTS. TO THE MAXIMUM EXTENT PERMITTED BY LAW, TERNLUX DISCLAIMS ALL WARRANTIES, WHETHER
      EXPRESS, IMPLIED, STATUTORY, OR OTHERWISE, INCLUDING IMPLIED WARRANTIES OF MERCHANTABILITY,
      FITNESS FOR A PARTICULAR PURPOSE, TITLE, AND NON-INFRINGEMENT, AND ANY WARRANTIES ARISING
      FROM COURSE OF DEALING OR USAGE OF TRADE. TERNLUX DOES NOT WARRANT THAT THE SERVICES WILL
      BE UNINTERRUPTED, ERROR-FREE, OR SECURE, OR THAT AI OUTPUT OR ANY OPERATION WILL BE
      ACCURATE, RELIABLE, OR FIT FOR YOUR PURPOSE.
    </p>

    <h2>20. Limitation of liability</h2>
    <p className="df-caps">
      TO THE MAXIMUM EXTENT PERMITTED BY LAW, NEITHER PARTY WILL BE LIABLE FOR ANY INDIRECT,
      INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR EXEMPLARY DAMAGES, OR FOR LOST PROFITS, LOST
      REVENUE, OR LOSS OF OR DAMAGE TO DATA.
    </p>
    <p className="df-caps">
      TO THE MAXIMUM EXTENT PERMITTED BY LAW, TERNLUX’S TOTAL LIABILITY ARISING OUT OF OR
      RELATING TO THE SERVICES WILL NOT EXCEED THE GREATER OF (A) THE FEES YOU PAID TO TERNLUX
      FOR THE CLOUD SERVICE IN THE TWELVE MONTHS PRECEDING THE EVENT GIVING RISE TO THE CLAIM, OR
      (B) US $100. FOR THE FREE DESKTOP APP, TERNLUX’S TOTAL LIABILITY WILL NOT EXCEED US $100.
    </p>
    <p>
      The exclusions and cap do not apply to your payment obligations, your indemnification
      obligations under Section 21, or your breach of Sections 13 or 14, and do not apply to
      liability that cannot be limited by law. Ternlux’s indemnification obligations under
      Section 21 are subject to the separate limit stated in that Section rather than the cap in
      this Section.
    </p>
    <p>
      You acknowledge that the fees (or the free provision of the Desktop App) reflect this
      allocation of risk, and that these limitations are an essential basis of the agreement.
    </p>

    <h2>21. Indemnification</h2>
    <p>
      Ternlux will defend Customer against any third-party claim alleging that the Cloud Service,
      as provided by Ternlux and used by Customer in accordance with these Terms, infringes that
      third party’s patent, copyright, or trademark or misappropriates its trade secret, and will
      indemnify Customer for damages and reasonable costs finally awarded against Customer on
      such a claim. If the Cloud Service becomes, or Ternlux believes it may become, the subject
      of such a claim, Ternlux may at its option and expense: (a) procure the right for Customer
      to continue using the Cloud Service; (b) modify or replace the affected functionality to
      make it non-infringing while materially preserving its functionality; or (c) if neither (a)
      nor (b) is commercially reasonable, terminate the affected subscription and refund any
      prepaid, unused fees for the terminated portion. This Section states Ternlux’s entire
      liability, and Customer’s exclusive remedy, for any claim of infringement or
      misappropriation.
    </p>
    <p>
      Notwithstanding Section 20, Ternlux’s total liability under this paragraph, including
      defense costs, will not exceed the greater of (a) three times the fees Customer paid to
      Ternlux for the Cloud Service in the twelve months preceding the claim, or (b) US $50,000.
    </p>
    <p>
      Ternlux has no obligation under this Section for any claim arising from: (a) the Desktop
      App, the Open-Source Software, Unofficial Builds, Third-Party Plugins, or any free or beta
      offering; (b) Customer Content, Connected Systems, or AI Output;
      (c) combination of the Cloud Service with products, data, or services not provided by
      Ternlux, where the claim would not have arisen but for the combination; (d) modifications
      not made by Ternlux; or (e) Customer’s use of the Cloud Service other than in accordance
      with these Terms.
    </p>
    <p>
      You will defend, indemnify, and hold harmless Ternlux and its affiliates from and against
      any third-party claim, and any resulting losses, arising out of or relating to: (a)
      Customer Content and its legality, including your rights and legal bases to process it; (b)
      your breach of the AUP or Section 14; (c) your breach of any third party’s terms through
      your use of the Services; (d) the permissions you grant under Section 9; and (e) your
      breach of these Terms.
    </p>
    <p>
      The following applies to both indemnities in this Section. The party seeking
      indemnification (the “Indemnified Party”) must promptly notify the other party (the
      “Indemnifying Party”) in writing of any claim for which indemnification is sought; failure
      to give prompt notice relieves the Indemnifying Party of its obligations under this Section
      only to the extent it is actually and materially prejudiced by the delay. The Indemnifying
      Party has sole control of the defense and settlement of the claim, including selection of
      counsel, provided that it conducts the defense in good faith. The Indemnified Party will
      provide reasonable cooperation, information, and assistance at the Indemnifying Party’s
      expense, and may participate in the defense with its own counsel at its own expense. The
      Indemnifying Party may not settle any claim in a manner that admits fault or liability on
      the part of the Indemnified Party, imposes any non-monetary obligation or injunctive relief
      on the Indemnified Party, or fails to include a full release of the Indemnified Party,
      without the Indemnified Party’s prior written consent, which will not be unreasonably
      withheld. The Indemnified Party may not settle or compromise any claim, or make any
      admission concerning it, without the Indemnifying Party’s prior written consent.
    </p>

    <h2>22. Term, suspension, and termination</h2>
    <p>
      These Terms apply while you use any Service. Cloud subscriptions continue for the term
      selected and renew per Section 12.
    </p>
    <p>
      We may suspend or terminate access, in whole or in part, for non-payment, AUP or security
      violations, submission of prohibited data, legal requirement, or, for the Cloud Service,
      prolonged inactivity. We may suspend or terminate your access to Ternlux-operated services
      (including your account, the plugin catalog, and updates) for material breach. Termination
      does not affect any right you have under the Open-Source License.
    </p>
    <p>
      On termination, access ends, scheduled workflows stop, and stored credentials and OAuth
      tokens are deleted. Unused Cloud Credits are forfeited without refund. Subject to the DPA,
      Ternlux will make Customer Content available for export after termination for 30 days,
      after which it will be deleted in accordance with the DPA.
    </p>
    <p>
      Sections 1, 8, 9, 10, 11, 12, 14, 16, 17, 19, 20, 21, 22, 23, 24, and 25, and any provision
      that by its nature should survive, survive termination.
    </p>

    <h2>23. Changes to the Services and these Terms</h2>
    <p>
      Ternlux may modify these Terms and the related documents. We will provide notice of
      material changes through the in-product terms-acceptance flow or other reasonable means.
      Changes are effective on the stated effective date, and your continued use after that date
      constitutes acceptance. We may also modify, suspend, or discontinue any part of the
      Services.
    </p>

    <h2>24. Governing law and dispute resolution</h2>
    <p>
      These Terms are governed by the laws of the State of California, without regard to its
      conflict-of-laws rules.
    </p>
    <p>
      Any dispute arising out of or relating to these Terms or the Services will be finally
      resolved by binding arbitration administered by JAMS under its then-current commercial
      rules, before one arbitrator, seated in Orange County, California, in English. Judgment on
      the award may be entered in any court of competent jurisdiction. Either party may seek
      injunctive relief in the state or federal courts located in Orange County, California for
      infringement or misuse of intellectual property or confidential information, and the
      parties consent to that venue.
    </p>
    <p>
      Disputes will be conducted only on an individual basis and not as a class, consolidated, or
      representative action. The arbitrator may not consolidate more than one party’s claims.
    </p>

    <h2>25. Confidentiality</h2>
    <p>
      “Confidential Information” means non-public information disclosed by one party
      (“Discloser”) to the other (“Recipient”) in connection with the Services that is identified
      as confidential at disclosure or that a reasonable person would understand to be
      confidential given its nature and the circumstances, including security information and
      business or technical information.
    </p>
    <p>
      Confidential Information does not include information that the Recipient can demonstrate:
      (a) is or becomes public through no fault of the Recipient; (b) was known to the Recipient
      without a duty of confidentiality before disclosure; (c) is rightfully obtained by the
      Recipient from a third party without a duty of confidentiality; or (d) was independently
      developed by the Recipient without use of or reference to the Discloser’s Confidential
      Information.
    </p>
    <p>
      The Recipient will use the Discloser’s Confidential Information only to exercise its rights
      and perform its obligations under these Terms, will protect it using at least the degree of
      care it uses for its own information of like importance and no less than reasonable care,
      and will not disclose it except to its employees, contractors, and advisors who need to
      know it and are bound by confidentiality obligations at least as protective as these. The
      Recipient is responsible for any breach of this Section by those persons.
    </p>
    <p>
      The Recipient may disclose Confidential Information to the extent required by law or legal
      process, provided that, where legally permitted, it gives the Discloser reasonable prior
      notice and cooperates in any effort to obtain confidential treatment. On the Discloser’s
      request following termination, the Recipient will return or destroy the Discloser’s
      Confidential Information, except for copies retained in routine backups or as required by
      law, which remain subject to this Section.
    </p>
    <p>
      The parties acknowledge that unauthorized use or disclosure of Confidential Information may
      cause irreparable harm for which monetary damages are an inadequate remedy, and that the
      Discloser is entitled to seek injunctive relief as provided in Section 24, in addition to
      any other remedies.
    </p>

    <h2>26. General</h2>
    <p>
      These Terms, together with the incorporated documents, are the entire agreement between the
      parties regarding the Services and supersede all prior agreements on that subject, except
      that the Open-Source License governs the Open-Source Software. If any
      provision is held unenforceable, it will be modified to the minimum extent necessary and
      the remainder will remain in effect. Ternlux’s failure to enforce a provision is not a
      waiver. You may not assign these Terms without Ternlux’s consent; Ternlux may assign them
      in connection with a merger, acquisition, or sale of assets. Neither party is liable for
      delays or failures caused by events beyond its reasonable control. Notices to Ternlux may
      be sent to support@ternlux.com. There are no third-party beneficiaries.
    </p>
    <p>
      By using the Services, you acknowledge that you have read and agree to these Terms.
    </p>
  </Box>
);

const TermsAndConditions = ({ onComplete }) => {
  const [accepted, setAccepted] = useState(false);
  // Analytics is a choice, not a default: `null` means the user has not made
  // one yet, and neither button is selected until they do. Continue is gated on
  // it, so nobody is opted in — or out — by a switch they never touched.
  const [analyticsOptIn, setAnalyticsOptIn] = useState(null);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const chooseAnalytics = (value) => {
    setAnalyticsOptIn(value);
    setError('');
  };

  const handleContinue = async () => {
    if (!accepted) {
      setError('You must accept the Terms and Conditions to continue.');
      return;
    }
    if (analyticsOptIn === null) {
      setError('Choose whether to share anonymous analytics to continue.');
      return;
    }
    setSubmitting(true);
    try {
      const acceptedAt = new Date().toISOString();
      localStorage.setItem(STORAGE_KEY_ACCEPTED, 'true');
      localStorage.setItem(STORAGE_KEY_VERSION, TERMS_VERSION);
      localStorage.setItem(STORAGE_KEY_ANALYTICS, analyticsOptIn ? 'true' : 'false');
      localStorage.setItem('ternlux_terms_accepted_at', acceptedAt);

      try {
        await window.electronAPI?.terms?.save?.({
          accepted: true,
          version: TERMS_VERSION,
          acceptedAt,
          analyticsOptIn,
        });
      } catch (e) {
        console.warn('Could not persist terms acceptance via main:', e);
      }

      try {
        await window.electronAPI?.analytics?.setOptIn(analyticsOptIn);
      } catch (e) {
        console.warn('Could not push analytics opt-in to main:', e);
      }

      onComplete?.({ analyticsOptIn });
    } catch (e) {
      setError('Unable to save your preferences. Please try again.');
      setSubmitting(false);
    }
  };

  return (
    <Box
      sx={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        bgcolor: '#f8f9fa',
        zIndex: 9999,
      }}
    >
      {/* Header */}
      <Box
        sx={{
          px: 4,
          pt: 2.5,
          pb: 2,
          borderBottom: '1px solid',
          borderColor: 'divider',
          bgcolor: 'background.paper',
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, ml: 8 }}>
          <Box>
            <Typography variant="h6" fontWeight={700} lineHeight={1.2}>
              Ternlux — Terms & Privacy
            </Typography>
            <Typography variant="caption" color="text.secondary">
              Please review and accept before continuing
            </Typography>
          </Box>
        </Box>
      </Box>

      {/* Body */}
      <Box
        sx={{
          flex: 1,
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'center',
          overflowY: 'auto',
          p: 4,
        }}
      >
        <Paper
          variant="outlined"
          sx={{
            width: '100%',
            maxWidth: 760,
            borderRadius: 3,
            p: { xs: 3, sm: 4 },
          }}
        >
          <Typography variant="h5" fontWeight={800} mb={0.5} textAlign="center">
            Welcome to Ternlux
          </Typography>
          <Typography variant="body2" color="text.secondary" mb={2} textAlign="center">
            Before you get started, take a moment to review our Terms and Conditions
            and choose your analytics preference.
          </Typography>

          {/* The published documents, reachable without scrolling the snapshot
              below — the acceptance line links to the same two. */}
          <Box sx={{ display: 'flex', justifyContent: 'center', gap: 3, mb: 3 }}>
            <DocLink href={TERMS_URL}>Terms and Conditions</DocLink>
            <DocLink href={PRIVACY_URL}>Privacy Policy</DocLink>
          </Box>

          {/* Terms scroll area */}
          <Paper
            variant="outlined"
            sx={{
              maxHeight: 320,
              overflowY: 'auto',
              p: 3,
              borderRadius: 2,
              bgcolor: 'grey.50',
              mb: 3,
            }}
          >
            <TermsOfServiceBody />
          </Paper>

          {/* Analytics opt-in card */}
          <Card
            variant="outlined"
            sx={{
              borderRadius: 2,
              borderWidth: 2,
              borderColor: analyticsOptIn === null ? 'divider' : 'primary.main',
              bgcolor: analyticsOptIn ? 'primary.50' : 'background.paper',
              transition: 'all 0.15s ease',
              mb: 3,
            }}
          >
            <CardContent sx={{ p: 2.5, '&:last-child': { pb: 2.5 } }}>
              <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 2 }}>
                <Box
                  sx={{
                    width: 40,
                    height: 40,
                    borderRadius: 2,
                    bgcolor: analyticsOptIn ? 'primary.main' : 'grey.200',
                    color: analyticsOptIn ? '#fff' : 'text.secondary',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                    transition: 'all 0.15s ease',
                  }}
                >
                  <InsightsOutlined sx={{ fontSize: 22 }} />
                </Box>

                <Box sx={{ flex: 1 }}>
                  <Typography variant="subtitle1" fontWeight={700} mb={0.5}>
                    Share anonymous analytics
                  </Typography>
                  <Typography variant="body2" color="text.secondary" lineHeight={1.5}>
                    Help us improve Ternlux by sharing anonymous usage data — feature
                    interactions, performance metrics, and crash reports. We never
                    collect your workflow contents, credentials, or personally
                    identifiable information. You can change this at any time in
                    Settings.
                  </Typography>

                  {/* Two buttons rather than a switch: a switch has a default,
                      and a default is an answer the user never gave. Neither is
                      selected until one is clicked. */}
                  <Box sx={{ display: 'flex', gap: 1.5, mt: 2 }}>
                    <Button
                      variant={analyticsOptIn === true ? 'contained' : 'outlined'}
                      onClick={() => chooseAnalytics(true)}
                      aria-pressed={analyticsOptIn === true}
                      startIcon={analyticsOptIn === true ? <CheckCircle /> : null}
                      sx={{ borderRadius: 2, fontWeight: 700, px: 2.5, textTransform: 'none' }}
                    >
                      Opt in
                    </Button>
                    <Button
                      variant={analyticsOptIn === false ? 'contained' : 'outlined'}
                      color={analyticsOptIn === false ? 'inherit' : 'primary'}
                      onClick={() => chooseAnalytics(false)}
                      aria-pressed={analyticsOptIn === false}
                      startIcon={analyticsOptIn === false ? <CheckCircle /> : null}
                      sx={{ borderRadius: 2, fontWeight: 700, px: 2.5, textTransform: 'none' }}
                    >
                      Opt out
                    </Button>
                  </Box>

                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mt: 1.75 }}>
                    <ShieldOutlined sx={{ fontSize: 14, color: 'text.disabled' }} />
                    <Typography variant="caption" color="text.disabled">
                      {analyticsOptIn === null
                        ? 'Pick one to continue — no analytics are sent until you do.'
                        : analyticsOptIn
                          ? 'Anonymous & aggregated. No workflow data is ever sent.'
                          : 'No analytics will be sent. Nothing about your usage leaves this device.'}
                    </Typography>
                  </Box>
                </Box>
              </Box>
            </CardContent>
          </Card>

          {error && (
            <Alert severity="error" sx={{ mb: 2, borderRadius: 2 }}>
              {error}
            </Alert>
          )}

          <FormControlLabel
            control={
              <Checkbox
                checked={accepted}
                onChange={(e) => {
                  setAccepted(e.target.checked);
                  if (e.target.checked) setError('');
                }}
                sx={{ mt: -0.5 }}
              />
            }
            label={
              <Typography variant="body2" sx={{ mt: 1 }}>
                I have read and agree to the{' '}
                <DocLink href={TERMS_URL}>Terms and Conditions</DocLink>
                {' '}and the{' '}
                <DocLink href={PRIVACY_URL}>Privacy Policy</DocLink>.
              </Typography>
            }
            sx={{ alignItems: 'flex-start', mb: 2 }}
          />

          <Divider sx={{ mb: 2.5 }} />

          <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1.5 }}>
            <Button
              variant="contained"
              onClick={handleContinue}
              disabled={!accepted || analyticsOptIn === null || submitting}
              startIcon={<CheckCircle />}
              sx={{
                borderRadius: 2,
                fontWeight: 700,
                py: 1.1,
                px: 3,
              }}
            >
              {submitting ? 'Saving...' : 'Accept & Continue'}
            </Button>
          </Box>
        </Paper>
      </Box>
    </Box>
  );
};

export default TermsAndConditions;
