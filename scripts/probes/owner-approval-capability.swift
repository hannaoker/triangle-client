// Non-interactive feasibility probe only. Never authenticates or authorizes a write.
import Foundation
import LocalAuthentication

let context = LAContext()
context.interactionNotAllowed = true
var error: NSError?
let available = context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error)
let result: [String: Any] = [
    "probe": "owner-authentication-capability",
    "policyAvailable": available,
    "authenticationAttempted": false,
    "approvalGranted": false,
    "errorDomain": error?.domain ?? NSNull(),
    "errorCode": error.map { NSNumber(value: $0.code) } ?? NSNull(),
]
let data = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
print(String(decoding: data, as: UTF8.self))
context.invalidate()
