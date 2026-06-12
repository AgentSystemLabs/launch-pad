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

# Prebuilt linux/amd64 EDGE agent binary (scripts/build-agent-binaries.sh →
# packages/agent-rust/dist/agent-edge).
variable "agent_binary_path" {
  type = string
}

variable "agent_version" {
  type    = string
  default = "0.0.0"
}

variable "ami_name_prefix" {
  type    = string
  default = "launch-pad-golden-edge"
}

locals {
  build_time = formatdate("YYYYMMDD-hhmmss", timestamp())
  ami_name   = "${var.ami_name_prefix}-${var.agent_version}-${local.build_time}"
}

# EDGE golden AMI: Caddy + CloudWatch Agent + the Rust edge agent. Deliberately NO
# Docker and NO Node.js — an edge node's only job is S3 upstream shards → Caddy, and
# the slimmer footprint keeps a t3.micro comfortable (the standard AL2023 base is
# kept over "minimal" because it ships the SSM agent `node upgrade-agent` depends on).
source "amazon-ebs" "launch_pad_golden_edge" {
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
    volume_size           = 8
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
    LaunchPadRole = "edge"
    AgentType     = "rust"
    AgentVersion  = var.agent_version
  }
}

build {
  name    = "launch-pad-golden-edge"
  sources = ["source.amazon-ebs.launch_pad_golden_edge"]

  provisioner "file" {
    source      = var.agent_binary_path
    destination = "/tmp/launchpad-agent"
  }

  provisioner "shell" {
    inline = [
      "set -euxo pipefail",
      "sudo mkdir -p /etc/launch-pad /var/lib/launch-pad /opt/launch-pad /var/log/launch-pad",
      "sudo dnf install -y amazon-cloudwatch-agent",
      "curl -fsSL 'https://caddyserver.com/api/download?os=linux&arch=amd64' -o /tmp/caddy",
      "sudo install -m 755 /tmp/caddy /usr/local/bin/caddy",
      "sudo install -m 755 /tmp/launchpad-agent /opt/launch-pad/agent",
      "sudo dnf clean all",
      "sudo rm -rf /var/cache/dnf /tmp/caddy /tmp/launchpad-agent",
    ]
  }

  # The AMI is shared publicly — scrub build-instance residue (packer's SSH key,
  # cloud-init instance state, machine-id, logs) before the snapshot is taken.
  provisioner "shell" {
    inline = [
      "sudo cloud-init clean --logs",
      "sudo rm -f /home/ec2-user/.ssh/authorized_keys /root/.ssh/authorized_keys",
      "sudo rm -rf /var/log/amazon /var/log/journal/* /var/lib/amazon/ssm/*",
      "sudo truncate -s 0 /etc/machine-id",
    ]
  }

  post-processor "manifest" {
    output     = "infra/packer/latest-manifest-edge.json"
    strip_path = true
    custom_data = {
      role          = "edge"
      agent_type    = "rust"
      agent_version = var.agent_version
      architecture  = "x86_64"
    }
  }
}
