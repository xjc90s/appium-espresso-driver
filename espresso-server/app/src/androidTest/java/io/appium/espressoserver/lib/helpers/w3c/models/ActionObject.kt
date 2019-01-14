package io.appium.espressoserver.lib.helpers.w3c.models

import java.util.concurrent.Callable

import io.appium.espressoserver.lib.handlers.exceptions.AppiumException
import io.appium.espressoserver.lib.handlers.exceptions.InvalidArgumentException
import io.appium.espressoserver.lib.helpers.w3c.adapter.W3CActionAdapter
import io.appium.espressoserver.lib.helpers.w3c.dispatcher.BaseDispatchResult
import io.appium.espressoserver.lib.helpers.w3c.models.InputSource.ActionType
import io.appium.espressoserver.lib.helpers.w3c.models.InputSource.InputSourceType
import io.appium.espressoserver.lib.helpers.w3c.models.InputSource.PointerType
import io.appium.espressoserver.lib.helpers.w3c.state.InputState
import io.appium.espressoserver.lib.helpers.w3c.state.InputStateTable
import io.appium.espressoserver.lib.helpers.w3c.state.KeyInputState
import io.appium.espressoserver.lib.helpers.w3c.state.PointerInputState

import io.appium.espressoserver.lib.helpers.w3c.dispatcher.KeyDispatch.dispatchKeyDown
import io.appium.espressoserver.lib.helpers.w3c.dispatcher.KeyDispatch.dispatchKeyUp
import io.appium.espressoserver.lib.helpers.w3c.dispatcher.PointerDispatch.dispatchPointerCancel
import io.appium.espressoserver.lib.helpers.w3c.dispatcher.PointerDispatch.dispatchPointerDown
import io.appium.espressoserver.lib.helpers.w3c.dispatcher.PointerDispatch.dispatchPointerMove
import io.appium.espressoserver.lib.helpers.w3c.dispatcher.PointerDispatch.dispatchPointerUp
import io.appium.espressoserver.lib.helpers.w3c.models.InputSource.InputSourceType.KEY
import io.appium.espressoserver.lib.helpers.w3c.models.InputSource.InputSourceType.POINTER

data class ActionObject(
        val id: String,
        val type: InputSourceType,
        val subType: ActionType,
        val index: Int = -1
) {
    var duration: Float = 0F
    var x = 0F
    var y = 0F
    var button = 0
    var value = ""
    var pointer = PointerType.TOUCH
    var origin = Origin()

    /**
     * Call `dispatch tick actions` algorithm in section 17.4
     * @param adapter Adapter for actions
     * @param inputStateTable State of all inputs
     * @param tickDuration How long the tick is
     * @param timeAtBeginningOfTick When the tick began
     * @return
     * @throws AppiumException
     */
    fun dispatch(adapter: W3CActionAdapter,
                 inputStateTable: InputStateTable,
                 tickDuration: Float, timeAtBeginningOfTick: Long): Callable<BaseDispatchResult>? {
        val inputSourceType = this.type
        val actionType = this.subType
        adapter.logger.info("Dispatching action #$index of input source $id");

        // 1.3 If the current session's input state table doesn't have a property corresponding to
        //      source id, then let the property corresponding to source id be a new object of the
        //      corresponding input source state type for source type.
        // 1.4 Let device state be the input source state corresponding to source id in the current session’s input state table
        val deviceState = inputStateTable.getOrCreateInputState(this.id, this)
        try {

            if (inputSourceType == KEY) {
                when (actionType) {
                    InputSource.ActionType.KEY_DOWN -> dispatchKeyDown(adapter, this, deviceState as KeyInputState, inputStateTable, tickDuration)
                    InputSource.ActionType.KEY_UP -> dispatchKeyUp(adapter, this, deviceState as KeyInputState, inputStateTable, tickDuration)
                    else -> { }
                }
            } else if (inputSourceType == POINTER) {
                when (actionType) {
                    InputSource.ActionType.POINTER_MOVE -> return dispatchPointerMove(
                            adapter,
                            this.id,
                            this,
                            deviceState as PointerInputState,
                            tickDuration,
                            timeAtBeginningOfTick,
                            inputStateTable.globalKeyInputState
                    )
                    InputSource.ActionType.POINTER_DOWN -> {
                        dispatchPointerDown(
                                adapter,
                                this,
                                deviceState as PointerInputState,
                                inputStateTable,
                                inputStateTable.globalKeyInputState
                        )
                        return null
                    }
                    InputSource.ActionType.POINTER_UP -> {
                        dispatchPointerUp(
                                adapter,
                                this,
                                deviceState as PointerInputState,
                                inputStateTable,
                                inputStateTable.globalKeyInputState
                        )
                        return null
                    }
                    InputSource.ActionType.POINTER_CANCEL -> {
                        dispatchPointerCancel(
                                adapter,
                                this
                        )
                        return null
                    }
                    else -> adapter.logger.info("Dispatching pause event for %$duration milliseconds");
                }
            }
        } catch (cce: ClassCastException) {
            val deviceStateClassName = deviceState.javaClass.simpleName;
            throw InvalidArgumentException("""
                Attempted to apply action of type '$inputSourceType' to a
                source with type '$deviceStateClassName': ${cce.message}
            """.trimIndent());
        }

        return null
    }
}
