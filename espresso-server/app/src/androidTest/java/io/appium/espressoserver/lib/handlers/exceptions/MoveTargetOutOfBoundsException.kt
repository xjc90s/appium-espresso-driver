package io.appium.espressoserver.lib.handlers.exceptions


import io.appium.espressoserver.lib.helpers.Rect

class MoveTargetOutOfBoundsException : AppiumException {

    constructor(targetX: Float, targetY: Float, boundingRect: Rect) : super(String.format(
            "The target [%s, %s] for pointer interaction is not in the viewport %s and cannot be brought into the viewport",
            targetX, targetY, boundingRect.toShortString()
    )) {
    }

    constructor(message: String) : super(message) {}
}
