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

variable "agent_binary_path" {
  type = string
}

variable "agent_version" {
  type    = string
  default = "0.0.0"
}

variable "ami_name_prefix" {
  type    = string
  default = "launch-pad-golden"
}

locals {
  build_time = formatdate("YYYYMMDD-hhmmss", timestamp())
  ami_name   = "${var.ami_name_prefix}-${var.agent_version}-${local.build_time}"
}

source "amazon-ebs" "launch_pad_golden" {
  region          = var.region
  instance_type   = "t3.small"
  ssh_username    = "ec2-user"
  ami_name        = local.ami_name
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
    Name         = local.ami_name
    Project      = "launch-pad"
    ManagedBy    = "packer"
    AgentType    = "rust"
    AgentVersion = var.agent_version
  }
}

build {
  name    = "launch-pad-golden"
  sources = ["source.amazon-ebs.launch_pad_golden"]

  provisioner "file" {
    source      = var.agent_binary_path
    destination = "/tmp/launch-pad-agent"
  }

  provisioner "shell" {
    inline = [
      "set -euxo pipefail",
      "sudo mkdir -p /etc/launch-pad /var/lib/launch-pad /opt/launch-pad /var/log/launch-pad",
      "curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -",
      "sudo dnf install -y docker nodejs amazon-cloudwatch-agent",
      "curl -fsSL 'https://caddyserver.com/api/download?os=linux&arch=amd64' -o /tmp/caddy",
      "sudo install -m 755 /tmp/caddy /usr/local/bin/caddy",
      "sudo install -m 755 /tmp/launch-pad-agent /opt/launch-pad/agent",
      "sudo systemctl enable docker",
      "sudo dnf clean all",
      "sudo rm -rf /var/cache/dnf /tmp/caddy /tmp/launch-pad-agent",
    ]
  }

  post-processor "manifest" {
    output     = "infra/packer/latest-manifest.json"
    strip_path = true
    custom_data = {
      agent_type    = "rust"
      agent_version = var.agent_version
      architecture  = "x86_64"
    }
  }
}
