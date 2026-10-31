# Single-node OpenBao on the internal aster_vault network. No ports are published, and only the
# MITM container is attached to that network, so the listener is reachable only from aster-mitm.
# TLS is off because the listener never leaves that private network. If aster-mitm is ever moved to a
# shared network, enable TLS here and update OPENBAO_ADDR in compose.yml.
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
