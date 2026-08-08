// Render MessageStats' icon at macOS app-icon spec from the vector source.
//
// The supplied art is a flat 1024×1024 square. macOS does not mask app icons,
// so shipping that gives a hard-edged square that also reads as oversized next
// to every neighbour in the Dock. Apple's grid puts the icon body in an
// 824×824 squircle centred in a 1024×1024 canvas, with the rest transparent.

import AppKit

let canvas = 1024.0
let inset = 100.0
let body = canvas - inset * 2   // 824

/// Apple's corner is a continuous curve, not a circular arc. A superellipse
/// with n≈5 is the standard approximation and is visibly closer than
/// CGPath(roundedRect:) at large sizes.
func squircle(_ rect: CGRect, n: Double = 5, steps: Int = 720) -> CGPath {
  let p = CGMutablePath()
  let a = rect.width / 2, b = rect.height / 2
  for i in 0...steps {
    let t = Double(i) / Double(steps) * 2 * .pi
    let ct = cos(t), st = sin(t)
    let x = rect.midX + a * pow(abs(ct), 2 / n) * (ct < 0 ? -1 : 1)
    let y = rect.midY + b * pow(abs(st), 2 / n) * (st < 0 ? -1 : 1)
    i == 0 ? p.move(to: CGPoint(x: x, y: y)) : p.addLine(to: CGPoint(x: x, y: y))
  }
  p.closeSubpath()
  return p
}

func rgb(_ hex: UInt32) -> CGColor {
  CGColor(red: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255,
          blue: CGFloat(hex & 0xff) / 255, alpha: 1)
}

let blue = rgb(0x2a78d6), white = rgb(0xffffff)
let orange = rgb(0xeb6834), green = rgb(0x1baf7a)

guard let ctx = CGContext(data: nil, width: Int(canvas), height: Int(canvas),
                          bitsPerComponent: 8, bytesPerRow: 0,
                          space: CGColorSpaceCreateDeviceRGB(),
                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
  fatalError("could not create bitmap context")
}

ctx.clear(CGRect(x: 0, y: 0, width: canvas, height: canvas))

// Clip everything to the icon body.
ctx.addPath(squircle(CGRect(x: inset, y: inset, width: body, height: body)))
ctx.clip()
ctx.setFillColor(blue)
ctx.fill(CGRect(x: 0, y: 0, width: canvas, height: canvas))

// Draw the artwork in the source SVG's coordinate space: flip to y-down, then
// map its 1024 canvas onto the 824 body.
ctx.translateBy(x: 0, y: canvas)
ctx.scaleBy(x: 1, y: -1)
ctx.translateBy(x: inset, y: inset)
ctx.scaleBy(x: body / canvas, y: body / canvas)

ctx.setFillColor(white)
ctx.addPath(CGPath(roundedRect: CGRect(x: 196.6, y: 262.1, width: 639.0, height: 426.0),
                   cornerWidth: 131.1, cornerHeight: 131.1, transform: nil))
ctx.fillPath()

ctx.beginPath()                                     // the bubble's tail
ctx.move(to: CGPoint(x: 351.3, y: 685.0))
ctx.addLine(to: CGPoint(x: 351.3, y: 770.0))
ctx.addLine(to: CGPoint(x: 449.6, y: 685.0))
ctx.closePath()
ctx.fillPath()

for (cx, cy, r, color) in [(376.8, 458.8, 98.3, blue),
                           (573.4, 507.9, 65.5, orange),
                           (688.1, 393.2, 41.0, green)] {
  ctx.setFillColor(color)
  ctx.fillEllipse(in: CGRect(x: cx - r, y: cy - r, width: r * 2, height: r * 2))
}

guard let image = ctx.makeImage() else { fatalError("could not render") }
let rep = NSBitmapImageRep(cgImage: image)
rep.size = NSSize(width: canvas, height: canvas)
guard let png = rep.representation(using: .png, properties: [:]) else {
  fatalError("could not encode png")
}
try png.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
print("wrote \(CommandLine.arguments[1])")
