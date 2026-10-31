# Single-node OpenBao on the internal aster_default network. No ports are published.
# TLS is off because the listener is reachable only from containers on aster_default. If the network
# ever stops being private to Aster, enable TLS here and update OPENBAO_ADDR in compose.yml.
ui = false
disable_mlock = true
api_addr = "http://aster-openbao:8200"

storage "file" {
  path = "/openbao/file"
}

listener "tcp" {
  address     = "0.0.0.0:8200"
  tls_disable = true
}
