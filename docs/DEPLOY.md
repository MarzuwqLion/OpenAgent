# Deploying OpenAgent on a Free Oracle Cloud VM (about 10 minutes)

These are human steps; agents don't run them. The integration engineer copies them into `README.md`. Once the repo is generated and pushed to GitHub, this runs the agent 24/7 on Oracle Cloud for $0/month.

1. **Create the Oracle Cloud account and upgrade to Pay-As-You-Go ($0).**
   - Sign up at cloud.oracle.com.
   - Go to **Billing & Cost Management → Upgrade and Manage Payment** and switch to **Pay-As-You-Go**.
   - This unlocks commercial host capacity and stops idle-VM reclamation. The Always Free resources stay at $0.00/month.
2. **Provision one Ampere ARM64 instance.** Go to **Compute → Instances → Create Instance** and set:
   - **Image:** Ubuntu 24.04 LTS (Canonical), `aarch64`.
   - **Shape:** **Change Shape → Ampere (ARM64) → `VM.Standard.A1.Flex`**, with 2 OCPUs, 12 GB RAM and a 50 GB boot volume. That's well inside the free allowance.
   - **Networking:** keep every inbound port closed except 22 (SSH). Socket Mode needs no inbound web ports.
3. **Create the Slack app.**
   1. At [api.slack.com/apps](https://api.slack.com/apps), choose **Create New App → From a manifest**.
   2. Paste `slack-manifest.yaml` into the YAML tab, and install the app to your workspace.
   3. Copy the **App-Level Token** (`xapp-...`) and the **Bot User OAuth Token** (`xoxb-...`).
4. **Boot the agent on the VM.** SSH in and run:
   ```bash
   # Install Docker and Compose (Ubuntu 24.04 ARM64)
   curl -fsSL https://get.docker.com | sh
   sudo usermod -aG docker $USER && newgrp docker

   # Clone the repo and configure .env
   git clone https://github.com/<your-username>/<your-repo>.git
   cd <your-repo>
   cp .env.example .env
   nano .env   # paste your Slack tokens and LLM API keys

   # Launch in the background, 24/7
   docker compose up -d --build
   ```
