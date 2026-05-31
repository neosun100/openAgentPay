package openagentpay

import "fmt"

// APIError is returned on any non-2xx HTTP response. It carries the HTTP
// status, a best-effort machine code, a human-readable message, and the raw
// response body for forensics.
type APIError struct {
	Status  int
	Code    string
	Message string
	Raw     string
}

// Error implements the error interface.
func (e *APIError) Error() string {
	return fmt.Sprintf("openagentpay: request failed (status=%d code=%s): %s", e.Status, e.Code, e.Message)
}
