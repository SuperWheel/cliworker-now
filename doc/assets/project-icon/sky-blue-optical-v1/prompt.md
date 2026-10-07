# 天蓝胶囊 Logo 光学优化提示词

使用方式：内置 imagegen，透明背景，两轮编辑。

第一轮输入：用户附件《天蓝胶囊图标.png》。

## 第一轮：圆角与负空间

Use case: precise-object-edit
Asset type: refined existing geometric logo, transparent PNG
Input image 1: the exact edit target, not inspiration for a different logo.
Primary request: optically refine this exact blue capsule logo. The user's priority is perceptually even negative space and a coherent family of corner curves, NOT mechanically identical numeric spacing or radii.
Preserve: one connected blue outer bracket open on the right (top horizontal arm, left vertical stem, bottom horizontal arm); exactly three inner upright rounded rectangles arranged as one tall blue rectangle in the middle and two stacked rectangles at the right, upper sky blue and lower blue. Preserve their order, overall recognisable proportions, blue/sky-blue palette, flat graphic appearance, square canvas and similar overall scale and placement.
Spacing corrections: the current left vertical gap is too wide, the gap between the middle and right column is too narrow, and the top, bottom, and right-column inter-block gaps nearly touch. Rebalance these with a continuous, clean, medium-narrow breathing space. Open all the pinched horizontal gaps; slightly narrow the broad left vertical gap; balance the middle-to-right gap. All gaps should FEEL equally open when viewed small. Compensate optically where rounded edges recede: arc-to-arc and arc-to-flat shortest distances may differ from straight-to-straight distances, while their perceived white-space weight should match. Keep every inner block clearly separated from the frame and its neighbors.
Corner corrections: make the three upright blocks feel like one harmonious rounded-rectangle family with smoothly tangent, confident, rounded corners. Slightly soften the tall middle block's overly semicircular capsule character so it harmonizes with the shorter blocks; adjust the smaller blocks' rounding optically for their aspect ratios. Keep some straight sides on the upper-right block so it reads as a rounded rectangle, not a circle. Make the right-hand blocks visually equal width and align their side edges, preserving the shorter upper and longer lower hierarchy.
Finish: crisp smooth antialiased edges, clean flat blue fills faithful to the source, no edge debris, no texture, no new gradient or lighting. No extra symbols, text, outline, shadow, mockup, border, or decorations. Do not redesign the outer silhouette. Output one standalone refined logo on genuinely transparent background; transparency must fill both the canvas and every internal gap.

## 第二轮：定向微调间距

输入为第一轮输出。

Use case: precise-object-edit
Asset type: optical-spacing refinement of the supplied existing logo, transparent PNG
Image 1 is the edit target. Keep its connected blue outer bracket, its three inner rounded rectangles (one tall blue middle rectangle, a shorter sky-blue upper-right rectangle, a taller blue lower-right rectangle), colors, smooth rounded-rectangle corner style, square canvas, placement and overall scale.
Make ONLY a precise negative-space correction. The first draft has a left interior vertical gutter approximately twice the width of the middle/right gutter; the horizontal slit separating the two right blocks is also too tight. Move the entire tall middle block subtly LEFT, without making it wider, until the two vertical gutters LOOK equally open. Open the slit between the two right blocks slightly, by very slightly shortening both near their shared boundary. Slightly raise the bottom edges of both lower blue blocks so the gap to the lower bracket feels as open as the top gap. Keep the top edges of the middle and upper-right blocks aligned and the bottom edges of both lower blocks aligned.
The finished mark must have perceptually uniform, generous but still compact gaps everywhere: left bracket to center block, center block to right column, top bracket to inner blocks, bottom bracket to lower blocks, and between the two stacked right blocks. Assess the full visible negative-space shape, not merely minimum pixel distance. Arc-to-arc gaps can be optically compensated. Preserve the current harmonious rounding of all three inner rectangles and preserve the outer frame.
Keep flat fills faithful to input, clean antialiased contours, no edge debris or stray pixels. No new gradient, texture, shadow, text, ornament or symbols. Output one standalone logo with genuine transparent alpha throughout the background and every internal gap.

