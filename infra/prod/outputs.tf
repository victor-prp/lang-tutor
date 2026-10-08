output "image_tag" {
  description = "The tag of the last apply. scripts/infra.sh reads it back so a laptop apply keeps what is live."
  value       = var.image_tag
}

output "service_url" {
  value = aws_lightsail_container_service.app.url
}

output "public_url" {
  description = "Where the release workflow checks /health."
  value       = var.attach_domain ? "https://${var.domain}" : trimsuffix(aws_lightsail_container_service.app.url, "/")
}

output "app_cname_target" {
  description = "The value of the app CNAME at GoDaddy."
  value       = trimsuffix(trimprefix(aws_lightsail_container_service.app.url, "https://"), "/")
}

output "certificate_validation" {
  description = "The CNAME to add at GoDaddy so the certificate is issued."
  value = [for option in aws_lightsail_certificate.app.domain_validation_options : {
    name  = option.resource_record_name
    type  = option.resource_record_type
    value = option.resource_record_value
  }]
}

output "database_endpoint" {
  value = aws_lightsail_database.app.master_endpoint_address
}

output "database_url" {
  value     = local.database_url
  sensitive = true
}
