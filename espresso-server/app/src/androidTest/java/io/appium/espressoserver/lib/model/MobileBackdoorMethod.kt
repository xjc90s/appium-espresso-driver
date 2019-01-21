package io.appium.espressoserver.lib.model

import java.util.Collections

import io.appium.espressoserver.lib.helpers.BackdoorUtils

@SuppressWarnings("unused")
class MobileBackdoorMethod {
    val name: String? = null

    private var args: List<BackdoorMethodArg>? = null

    val rawArgs: List<BackdoorMethodArg>
        get() = if (args == null) {
            Collections.emptyList()
        } else args

    val argumentTypes: Array<Class<*>>
        get() {
            val rawArgs = rawArgs
            val types = arrayOfNulls<Class<*>>(rawArgs.size())
            for (i in 0 until rawArgs.size()) {
                types[i] = BackdoorUtils.parseType(rawArgs[i].getType())
            }
            return types
        }

    val arguments: Array<Object>
        get() {
            val rawArgs = rawArgs
            val parsedArgs = arrayOfNulls<Object>(rawArgs.size())
            for (i in 0 until rawArgs.size()) {
                parsedArgs[i] = BackdoorUtils.parseValue(rawArgs[i].getValue(),
                        BackdoorUtils.parseType(rawArgs[i].getType()))
            }
            return parsedArgs
        }
}