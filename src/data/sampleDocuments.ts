export interface SampleDocument {
  id: string;
  label: string;
  tag: string;
  content: string;
}

export const SAMPLE_DOCUMENTS: SampleDocument[] = [
  {
    id: 'saas-msa',
    label: 'Enterprise SaaS MSA (High-Risk Traps + PII)',
    tag: 'Contract',
    content: `MASTER SERVICES AGREEMENT
Prepared for: Acme Robotics Inc., 742 Evergreen Terrace, Suite 400, Austin, TX
Primary Contact: jordan.vance@acmerobotics.io | Phone: (512) 555-0194
Billing Verification: Tax ID 123-45-6789 | Corporate Card 4532-8910-4412-9089
Webhook Key Provisioned: sk-live-9f8a7b6c5d4e3f2a1b0c9d8e

1. TERM & AUTO-RENEWAL
This Agreement shall commence on the Effective Date for an initial 12-month term and shall automatically renew for successive 12-month periods unless Customer delivers written notice of non-renewal at least 90 days prior to expiration, with an automatic 12% uplift on renewal.

2. DATA RIGHTS & AI MODEL TRAINING
Customer grants Vendor a perpetual, irrevocable, worldwide, royalty-free license to process, analyze, and use Customer Data and workspace inputs for training our AI and machine learning models.

3. LIMITATION OF LIABILITY & INDEMNIFICATION
In no event shall Vendor's aggregate liability exceed $100 USD. Customer shall indemnify, defend, and hold Vendor harmless without limit against any third-party claim arising from Customer's use of the Service.

4. SECURITY INCIDENT NOTICE
Vendor will use commercially reasonable efforts to notify Customer within 30 days of confirming a security breach affecting Customer Data.

5. DISPUTE RESOLUTION
All disputes shall be resolved exclusively by binding arbitration in Dover, Delaware, and Customer waives any right to a jury trial or class action.`
  },
  {
    id: 'ai-privacy',
    label: 'Consumer AI App Privacy Policy',
    tag: 'Privacy Policy',
    content: `PRIVACY POLICY — LUMINA NOTES APP
Data Protection Officer: dpo-alerts@luminanotes.example | Support: +1 (415) 890-2211
Diagnostic Server Endpoint: 192.168.14.88 | EU IBAN Settlement: DE89370400440532013000

1. INFORMATION WE COLLECT
We collect account emails, uploaded voice memos, and device IP addresses.

2. HOW WE USE INFORMATION
We retain all user prompts indefinitely and grant ourselves an irrevocable, royalty-free license to train our AI models on user documents unless you opt out by postal mail sent to 1200 Market Street, San Francisco, CA.

3. CHANGES TO THIS POLICY
We may modify these terms at any time in our sole discretion without notice, and your continued use constitutes acceptance of all updated terms.

4. BREACH NOTIFICATION
We make no obligation to notify individual users within fixed statutory timelines outside commercially reasonable efforts.`
  },
  {
    id: 'vendor-dpa',
    label: 'Cloud API Vendor DPA (Clean Baseline)',
    tag: 'DPA',
    content: `DATA PROCESSING ADDENDUM — APEX INFRASTRUCTURE
Security Contact: security@apexinfra.example | Phone: 206-555-0148

1. PURPOSE & ZERO MODEL TRAINING
Processor shall process Customer Personal Data solely on documented instructions from Controller. Processor will never use Customer Personal Data to train AI models.

2. SECURITY & BREACH NOTIFICATION
Processor maintains SOC 2 Type II controls and shall notify Controller without undue delay and no later than 36 hours after becoming aware of a Personal Data Breach.

3. LIABILITY
Each party's aggregate liability under this DPA shall be subject to the mutual 12-month fee cap in the underlying MSA.`
  }
];
