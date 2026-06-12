packer {
  required_plugins {
    amazon = {
      version = ">= 1.3.0"
      source  = "github.com/hashicorp/amazon"
    }
  }
}

variable "region" {
  type    = string
  default = "us-east-1"
}

# Prebuilt linux/amd64 APP agent binary (scripts/build-agent-binaries.sh →
# packages/agent-rust/dist/agent-app).
variable "agent_binary_path" {
  type = string
}

variable "agent_version" {
  type    = string
  default = "0.0.0"
}

variable "ami_name_prefix" {
  type    = string
  default = "launch-pad-golden-app"
}

locals {
  build_time = formatdate("YYYYMMDD-hhmmss", timestamp())
  ami_name   = "${var.ami_name_prefix}-${var.agent_version}-${local.build_time}"
}

# APP golden AMI: Docker + CloudWatch Agent + the Rust app agent. Deliberately NO
# Caddy (Caddy never co-locates with app containers) and NO Node.js (the agent is a
# self-contained binary). Standard AL2023 base — it ships the SSM agent that
# `node upgrade-agent` depends on.
source "amazon-ebs" "launch_pad_golden_app" {
  region          = var.region
  instance_type   = "t3.small"
  ssh_username    = "ec2-user"
  ami_name        = local.ami_name
  # Public on purpose: the AMI ids are committed to the CLI's manifest and launched
  # from USERS' accounts. Nothing secret may ever be baked (see the cleanup step).
  ami_groups      = ["all"]
  snapshot_groups = ["all"]

  launch_block_device_mappings {
    device_name           = "/dev/xvda"
    volume_size           = 16
    volume_type           = "gp3"
    delete_on_termination = true
  }

  source_ami_filter {
    filters = {
      name                = "al2023-ami-*-kernel-*-x86_64"
      root-device-type    = "ebs"
      virtualization-type = "hvm"
      architecture        = "x86_64"
    }
    owners      = ["amazon"]
    most_recent = true
  }

  tags = {
    Name          = local.ami_name
    Project       = "launch-pad"
    ManagedBy     = "packer"
    LaunchPadRole = "app"
    AgentType     = "rust"
    AgentVersion  = var.agent_version
  }
}

build {
  name    = "launch-pad-golden-app"
  sources = ["source.amazon-ebs.launch_pad_golden_app"]

  provisioner "file" {
    source      = var.agent_binary_path
    destination = "/tmp/launchpad-agent"
  }

  provisioner "shell" {
    inline = [
      "set -euxo pipefail",
      "sudo mkdir -p /etc/launch-pad /var/lib/launch-pad /opt/launch-pad /var/log/launch-pad",
      "sudo dnf install -y docker amazon-cloudwatch-agent",
      "sudo install -m 755 /tmp/launchpad-agent /opt/launch-pad/agent",
      "sudo systemctl enable docker",
      "sudo dnf clean all",
      "sudo rm -rf /var/cache/dnf /tmp/launchpad-agent",
    ]
  }

  post-processor "manifest" {
    output     = "infra/packer/latest-manifest-app.json"
    strip_path = true
    custom_data = {
      role          = "app"
      agent_type    = "rust"
      agent_version = var.agent_version
      architecture  = "x86_64"
    }
  }
}
